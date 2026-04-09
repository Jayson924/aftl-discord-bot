const { Events, EmbedBuilder } = require('discord.js');
const supabase = require('../supabase');

function parseMessage(text) {
  const lower = text.toLowerCase();

  // Detect raid type
  let raidType = null;
  if (lower.includes('hardcore') || lower.includes('hc')) raidType = 'Hardcore';
  else if (lower.includes('classic')) raidType = 'Classic';

  // Try to extract a date from the message, otherwise use today
  const dateMatch = text.match(
    /(\w{3,9}\s+\d{1,2})|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/
  );
  const dateStr = dateMatch
    ? dateMatch[0]
    : new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return { raidType, dateStr };
}

async function analyzeScreenshot(buffer, mimeType, knownNames) {
  const base64 = buffer.toString('base64');

  const playerListHint = knownNames.length > 0
    ? `\n\nHere is a list of known player character names to help with matching. If a name in the screenshot closely matches one of these, use the known name exactly:\n${knownNames.join(', ')}`
    : '';

  const systemPrompt = `You are a Dragon Nest raid party screenshot analyzer. Extract the character names visible in the party/raid list screenshot.

The screenshot may show:
- A raid party list with up to 8 characters
- Each entry typically shows "Lv. 50 CharacterName" with a character portrait
- The party list is usually arranged in a 2-column grid (4 rows × 2 columns)
- Names might be partially obscured or have special characters
- Read left-to-right, top-to-bottom (left column entry first, then right column entry, for each row)

Return this JSON structure:
{
  "players": [
    { "name": "CharacterName" },
    { "name": "CharacterName2" }
  ],
  "notes": "any issues or things that couldn't be read clearly"
}

Rules:
- Return players in the order they appear in the screenshot (top to bottom)
- Read character names as accurately as possible — spelling matters for matching
- If a name is hard to read, give your best guess and mention it in notes
- Return ONLY the JSON, no markdown or code blocks${playerListHint}`;

  const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType, data: base64 },
            },
            {
              type: 'text',
              text: 'Extract the character names from this Dragon Nest raid party screenshot. Return only the JSON object.',
            },
          ],
        },
      ],
      system: systemPrompt,
    }),
  });

  if (!apiResponse.ok) {
    const errorText = await apiResponse.text();
    throw new Error(`Anthropic API error: ${errorText}`);
  }

  const data = await apiResponse.json();
  const text = data.content?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonMatch ? jsonMatch[0] : text);
}

function detectMimeType(buffer, fallback) {
  const header = buffer.slice(0, 8);
  if (header[0] === 0x89 && header[1] === 0x50) return 'image/png';
  if (header[0] === 0xff && header[1] === 0xd8) return 'image/jpeg';
  if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (header.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return fallback;
}

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    // Ignore bots and messages outside the loot channel
    if (message.author.bot) return;
    if (message.channel.id !== process.env.LOOT_CHANNEL_ID) return;

    // Must have an image attachment
    const attachment = message.attachments.find((a) =>
      a.contentType?.startsWith('image/')
    );
    if (!attachment) return;

    const { raidType, dateStr } = parseMessage(message.content);

    if (!raidType) {
      await message.reply(
        'Include the raid type in your message (e.g. "Hardcore Apr 9").'
      );
      return;
    }

    // React to show we're processing
    await message.react('⏳');

    try {
      // Download and detect image type
      const response = await fetch(attachment.url);
      const buffer = Buffer.from(await response.arrayBuffer());
      const mimeType = detectMimeType(buffer, attachment.contentType);

      // Get known players for better OCR matching
      const { data: knownPlayers } = await supabase
        .from('players')
        .select('name');
      const knownNames = (knownPlayers || []).map((p) => p.name);

      // Analyze screenshot
      const parsed = await analyzeScreenshot(buffer, mimeType, knownNames);
      const extractedNames = (parsed.players || [])
        .map((p) => p.name)
        .filter(Boolean);

      if (extractedNames.length === 0) {
        await message.reactions.removeAll();
        await message.reply('No player names found in the screenshot.');
        return;
      }

      // Look up players in Supabase
      const { data: players } = await supabase
        .from('players')
        .select('id, name, discord_id')
        .in('name', extractedNames);

      const playerMap = {};
      const discordMap = {};
      if (players) {
        for (const p of players) {
          playerMap[p.name] = p.id;
          if (p.discord_id) discordMap[p.name] = p.discord_id;
        }
      }

      // Save lineup to Supabase
      const baseName = `${raidType} — ${dateStr}`;

      const { data: existing } = await supabase
        .from('lineups')
        .select('name')
        .eq('raid_type', raidType)
        .like('name', `${baseName}%`);

      const count = existing?.length || 0;
      const lineupName = count === 0 ? baseName : `${baseName} #${count + 1}`;

      const { data: savedLineup, error: lineupError } = await supabase
        .from('lineups')
        .insert({
          name: lineupName,
          raid_type: raidType,
          status: 'ready',
          completed: false,
          is_template: false,
        })
        .select()
        .single();

      if (lineupError) {
        console.error('Error saving lineup:', lineupError);
      }

      if (savedLineup) {
        const lineupPlayers = extractedNames.map((name, i) => ({
          lineup_id: savedLineup.id,
          player_name: name,
          player_id: playerMap[name] || null,
          slot_position: i + 1,
        }));

        const { error: playersError } = await supabase
          .from('lineup_players')
          .insert(lineupPlayers);

        if (playersError) {
          console.error('Error saving lineup players:', playersError);
        }
      }

      // Build roster display
      const allMentions = new Set();
      const roster = extractedNames
        .map((name, i) => {
          const discordId = discordMap[name];
          if (discordId) {
            allMentions.add(discordId);
            return `\`${i + 1}.\` <@${discordId}>`;
          }
          return `\`${i + 1}.\` ${name}`;
        })
        .join('\n');

      const embed = new EmbedBuilder()
        .setTitle(`${raidType} Raid`)
        .setDescription(roster)
        .setColor(raidType === 'Hardcore' ? 0xe74c3c : 0x3498db)
        .setImage(attachment.url);

      if (savedLineup) {
        embed.addFields({
          name: 'Lineup',
          value: `Saved as "${lineupName}"`,
          inline: true,
        });
      }

      if (parsed.notes) {
        embed.setFooter({ text: parsed.notes });
      }

      // Remove processing reaction
      await message.reactions.removeAll();

      // Reply with embed, then create thread on the reply
      const reply = await message.reply({ embeds: [embed] });

      const thread = await reply.startThread({
        name: `${raidType} Loot — ${dateStr}${count > 0 ? ` #${count + 1}` : ''}`,
        reason: 'Loot discussion thread from screenshot',
      });

      if (allMentions.size > 0) {
        const pingStr = [...allMentions].map((id) => `<@${id}>`).join('\n');
        await thread.send(pingStr);
      }
    } catch (err) {
      console.error('Loot screenshot error:', err);
      await message.reactions.removeAll();
      await message.reply('Failed to process the screenshot. Try a clearer image.');
    }
  },
};

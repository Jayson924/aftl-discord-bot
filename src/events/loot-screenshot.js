const { Events, EmbedBuilder } = require('discord.js');
const supabase = require('../supabase');

function parseMessage(text) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  let raidType = null;
  if (lower.includes('hardcore') || lower.includes('hc')) raidType = 'Hardcore';
  else if (lower.includes('classic')) raidType = 'Classic';

  return { raidType, lineupName: trimmed || null };
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

async function processScreenshot(message, attachment, raidType, lineupName) {
  await message.react('⏳');

  try {
    const response = await fetch(attachment.url);
    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType = detectMimeType(buffer, attachment.contentType);

    const { data: knownPlayers } = await supabase
      .from('players')
      .select('name');
    const knownNames = (knownPlayers || []).map((p) => p.name);

    const parsed = await analyzeScreenshot(buffer, mimeType, knownNames);
    const extractedNames = (parsed.players || [])
      .map((p) => p.name)
      .filter(Boolean);

    if (extractedNames.length === 0) {
      await message.reactions.removeAll();
      await message.reply('No player names found in the screenshot.');
      return;
    }

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

    // Check for duplicate lineup names
    const { data: existing } = await supabase
      .from('lineups')
      .select('name')
      .like('name', `${lineupName}%`);

    const count = existing?.length || 0;
    const finalName = count === 0 ? lineupName : `${lineupName} #${count + 1}`;

    const { data: savedLineup, error: lineupError } = await supabase
      .from('lineups')
      .insert({
        name: finalName,
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
        player_name: playerMap[name] ? name : `[PUB] ${name}`,
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

    const allMentions = new Set();
    const roster = extractedNames
      .map((name, i) => {
        const discordId = discordMap[name];
        if (discordId) {
          allMentions.add(discordId);
          return `\`${i + 1}.\` <@${discordId}>`;
        }
        return `\`${i + 1}.\` [PUB] ${name}`;
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
        value: `Saved as "${finalName}"`,
        inline: true,
      });
    }

    if (parsed.notes) {
      embed.setFooter({ text: parsed.notes });
    }

    await message.reactions.removeAll();

    const thread = await message.startThread({
      name: `${finalName} — Loot`,
      reason: 'Loot discussion thread from screenshot',
    });

    await thread.send({ embeds: [embed] });

    if (allMentions.size > 0) {
      const pingStr = [...allMentions].map((id) => `<@${id}>`).join('\n');
      await thread.send(pingStr);
    }
  } catch (err) {
    console.error('Loot screenshot error:', err);
    await message.reactions.removeAll();
    await message.reply('Failed to process the screenshot. Try a clearer image.');
  }
}

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    if (message.author.bot) return;
    if (message.channel.id !== process.env.LOOT_CHANNEL_ID) return;

    const attachment = message.attachments.find((a) =>
      a.contentType?.startsWith('image/')
    );
    if (!attachment) return;

    let { raidType, lineupName } = parseMessage(message.content);

    // If no message text, ask for a name
    if (!lineupName) {
      const prompt = await message.reply(
        'Give this lineup a name (e.g. "Hardcore Apr 9"). Reply to this message with the name.'
      );

      const filter = (m) =>
        m.author.id === message.author.id && m.reference?.messageId === prompt.id;

      try {
        const collected = await message.channel.awaitMessages({
          filter,
          max: 1,
          time: 60_000,
          errors: ['time'],
        });
        const reply = collected.first();
        const parsed = parseMessage(reply.content);
        raidType = parsed.raidType;
        lineupName = parsed.lineupName || reply.content.trim();
      } catch {
        // Timed out — auto-generate a name
        const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        lineupName = `Raid — ${dateStr}`;
      }
    }

    if (!raidType) {
      raidType = 'Unspecified';
    }

    await processScreenshot(message, attachment, raidType, lineupName);
  },
};

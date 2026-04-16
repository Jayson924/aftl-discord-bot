const { SlashCommandBuilder, EmbedBuilder, ChannelType } = require('discord.js');
const supabase = require('../supabase');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lootthread')
    .setDescription('Parse a raid screenshot to create a loot discussion thread')
    .addStringOption(option =>
      option
        .setName('type')
        .setDescription('Raid type')
        .setRequired(true)
        .addChoices(
          { name: 'Hardcore', value: 'Hardcore' },
          { name: 'Classic', value: 'Classic' },
          { name: '4-Man', value: '4-man' },
        ),
    )
    .addAttachmentOption(option =>
      option
        .setName('screenshot')
        .setDescription('Screenshot of the raid party')
        .setRequired(true),
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const raidType = interaction.options.getString('type');
    const attachment = interaction.options.getAttachment('screenshot');

    // Image check
    if (!attachment.contentType?.startsWith('image/')) {
      return interaction.editReply({ content: 'Please attach an image file.' });
    }

    // Download the image and convert to base64
    const response = await fetch(attachment.url);
    const buffer = Buffer.from(await response.arrayBuffer());
    const base64 = buffer.toString('base64');

    // Don't trust discord, detect actual image type
    const header = buffer.slice(0, 8);
    let mimeType = attachment.contentType;
    if (header[0] === 0x89 && header[1] === 0x50) mimeType = 'image/png';
    else if (header[0] === 0xFF && header[1] === 0xD8) mimeType = 'image/jpeg';
    else if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') mimeType = 'image/webp';
    else if (header.toString('ascii', 0, 3) === 'GIF') mimeType = 'image/gif';

    // Get known player names for better matching
    const { data: knownPlayers } = await supabase
      .from('players')
      .select('name');

    const knownNames = (knownPlayers || []).map(p => p.name);

    // Send to Claude Vision API
    const playerListHint = knownNames.length > 0
      ? `\n\nHere is a list of known player character names to help with matching. If a name in the screenshot closely matches one of these, use the known name exactly:\n${knownNames.join(', ')}`
      : '';

    const systemPrompt = `You are a Dragon Nest raid party screenshot analyzer. Extract the character names visible in the party/raid list screenshot.

The screenshot may show:
- A raid party list with up to 8 characters (full raid) or 4 characters (4-man raid)
- Each entry typically shows "Lv. 50 CharacterName" with a character portrait
- Full raids are arranged in a 2-column grid (4 rows × 2 columns); 4-man parties may show a single column or a shorter list
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

    let parsed;
    try {
      const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
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
                  source: {
                    type: 'base64',
                    media_type: mimeType,
                    data: base64
                  }
                },
                {
                  type: 'text',
                  text: 'Extract the character names from this Dragon Nest raid party screenshot. Return only the JSON object.'
                }
              ]
            }
          ],
          system: systemPrompt
        })
      });

      if (!apiResponse.ok) {
        const errorText = await apiResponse.text();
        console.error('Anthropic API error:', errorText);
        return interaction.editReply({ content: 'Failed to analyze the screenshot.' });
      }

      const data = await apiResponse.json();
      const text = data.content?.[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch (err) {
      console.error('Screenshot parse error:', err);
      return interaction.editReply({ content: 'Failed to parse the screenshot. Try a clearer image.' });
    }

    const extractedNames = (parsed.players || []).map(p => p.name).filter(Boolean);

    if (extractedNames.length === 0) {
      return interaction.editReply({ content: 'No player names found in the screenshot.' });
    }

    // Look up player details by name
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

    // Save lineup to Supabase with auto-increment for same-day duplicates
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const baseName = `${raidType} — ${dateStr}`;

    // Check how many lineups with this base name already exist
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
      // Continue even if lineup save fails — thread creation is more important
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
    const roster = extractedNames.map((name, i) => {
      const discordId = discordMap[name];
      let display;
      if (discordId) {
        allMentions.add(discordId);
        display = `<@${discordId}>`;
      } else {
        display = name;
      }
      return `\`${i + 1}.\` ${display}`;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setTitle(`${raidType} Raid`)
      .setDescription(roster)
      .setColor(raidType === 'Hardcore' ? 0xe74c3c : 0x3498db)
      .setImage(attachment.url);

    if (savedLineup) {
      embed.addFields({ name: 'Lineup', value: `Saved as "${lineupName}"`, inline: true });
    }

    if (parsed.notes) {
      embed.setFooter({ text: parsed.notes });
    }

    // Send the embed as a message, then create a thread on it
    await interaction.editReply({ embeds: [embed] });
    const message = await interaction.fetchReply();

    const thread = await message.startThread({
      name: `${raidType} Loot — ${dateStr}${count > 0 ? ` #${count + 1}` : ''}`,
      reason: 'Loot discussion thread from screenshot',
    });

    if (allMentions.size > 0) {
      const pingStr = [...allMentions].map(id => `<@${id}>`).join('\n');
      await thread.send(`${pingStr}`);
    }
  },
};

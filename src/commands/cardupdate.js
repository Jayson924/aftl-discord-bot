const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const supabase = require('../supabase');

const RARITY_COLORS = {
  legend:  0xd62d49,
  unique:  0x8f5ce0,
  epic:    0xff9800,
  rare:    0x3b82f6,
  magic:   0x22c55e,
};

const RARITY_LABELS = {
  legend: 'Legend',
  unique: 'Unique',
  epic:   'Epic',
  rare:   'Rare',
  magic:  'Magic',
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('cardupdate')
    .setDescription('Upload a screenshot of a card tooltip to update one slot on your character')
    .addStringOption(option =>
      option
        .setName('character')
        .setDescription('Which of your characters to update')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addAttachmentOption(option =>
      option
        .setName('screenshot')
        .setDescription('Screenshot of the card tooltip (with Name and Item Level visible)')
        .setRequired(true),
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused();
    const { data: rows } = await supabase
      .from('players')
      .select('id, name, account_number, exclude, whitelisted')
      .eq('discord_id', interaction.user.id)
      .eq('exclude', false)
      .eq('whitelisted', true)
      .order('account_number')
      .order('name');

    const filtered = (rows || []).filter(p =>
      !focused || p.name.toLowerCase().includes(focused.toLowerCase())
    );

    await interaction.respond(
      filtered.slice(0, 25).map(p => ({
        name: p.account_number > 1 ? `${p.name} (Acct ${p.account_number})` : p.name,
        value: p.id,
      }))
    );
  },

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const playerId = interaction.options.getString('character');
    const attachment = interaction.options.getAttachment('screenshot');

    if (!attachment.contentType?.startsWith('image/')) {
      return interaction.editReply({ content: 'Please attach an image file.' });
    }

    // Verify the chosen character belongs to the caller (autocomplete sends back an id;
    // a determined user could still submit any uuid).
    const { data: player, error: playerErr } = await supabase
      .from('players')
      .select('id, name, discord_id, exclude, whitelisted')
      .eq('id', playerId)
      .single();

    if (playerErr || !player) {
      return interaction.editReply({ content: 'Character not found.' });
    }
    if (player.discord_id !== interaction.user.id) {
      return interaction.editReply({ content: "You can only update your own characters." });
    }
    if (player.exclude) {
      return interaction.editReply({ content: `**${player.name}** is excluded and cannot track a card collection.` });
    }
    if (!player.whitelisted) {
      return interaction.editReply({
        content: `**${player.name}** isn't whitelisted yet. Ask an admin to whitelist your character (must be in the guild) to track its card collection.`,
      });
    }

    // Load the card name → slot index mapping
    const { data: configRow } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', 'card_slot_names')
      .single();

    let nameMap = {};
    if (configRow?.value) {
      try {
        nameMap = typeof configRow.value === 'string'
          ? JSON.parse(configRow.value)
          : configRow.value;
      } catch {
        nameMap = {};
      }
    }

    const namedSlots = Object.entries(nameMap).filter(([, n]) => n && String(n).trim());
    if (namedSlots.length === 0) {
      return interaction.editReply({
        content: 'No card slots have been named yet. Ask an admin to set up the Card Map first.',
      });
    }

    // Download + detect mime
    const response = await fetch(attachment.url);
    const buffer = Buffer.from(await response.arrayBuffer());
    const base64 = buffer.toString('base64');

    const header = buffer.slice(0, 8);
    let mimeType = attachment.contentType;
    if (header[0] === 0x89 && header[1] === 0x50) mimeType = 'image/png';
    else if (header[0] === 0xFF && header[1] === 0xD8) mimeType = 'image/jpeg';
    else if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') mimeType = 'image/webp';
    else if (header.toString('ascii', 0, 3) === 'GIF') mimeType = 'image/gif';

    // Build the name hint so the vision model snaps OCR-noisy text to a known slot name
    const knownNames = namedSlots.map(([, name]) => name);
    const nameHint = `\n\nKnown card names in this guild's Card Map (return one of these EXACTLY when you recognise the card):\n${knownNames.join(', ')}`;

    const systemPrompt = `You are a Dragon Nest item tooltip analyzer. The screenshot shows a Monster Card tooltip.

Extract two things and ONLY these two things:

1. cardName — the card's name as a STRING.
   - The tooltip's title line looks like "Monster Card-<Card Name>" possibly followed by "(Equipped)".
   - Strip the leading "Monster Card-" / "Monster Card -" prefix.
   - Strip the trailing "(Equipped)" suffix and any whitespace.
   - Example: "Monster Card-Lizardman Brother Claw(Equipped)" → "Lizardman Brother Claw".

2. rarity — the card's rarity, taken from the "Item Level: <Rarity>" line.
   - Map the rarity text to one of: "legend", "unique", "epic", "rare", "magic" (lowercase).
   - If the line is absent or unreadable, return null for rarity.

Return ONLY this JSON, no markdown:
{
  "cardName": "Lizardman Brother Claw",
  "rarity": "legend",
  "confidence": "high|medium|low",
  "notes": "any issues"
}${nameHint}`;

    let parsed;
    try {
      const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 512,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
                { type: 'text', text: 'Extract the card name and rarity from this Dragon Nest monster card tooltip. Return only the JSON object.' },
              ],
            },
          ],
          system: systemPrompt,
        }),
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
      console.error('Card screenshot parse error:', err);
      return interaction.editReply({ content: 'Failed to parse the screenshot. Try a clearer image.' });
    }

    const cardName = (parsed.cardName || '').trim();
    const rarity = parsed.rarity;

    if (!cardName) {
      return interaction.editReply({ content: "Couldn't read the card name from the screenshot." });
    }
    if (!rarity || !RARITY_LABELS[rarity]) {
      return interaction.editReply({
        content: `Couldn't determine the rarity of **${cardName}**. Make sure the "Item Level" line is visible.`,
      });
    }

    // Exact, case-insensitive name match against the Card Map
    const target = cardName.toLowerCase();
    const match = namedSlots.find(([, name]) => name.toLowerCase() === target);

    if (!match) {
      return interaction.editReply({
        content: `Couldn't find a slot for **${cardName}**. Ask an admin to add this name in the Card Map (Admin → Card Map).`,
      });
    }

    const slotIndex = parseInt(match[0], 10);

    // Upsert the rarity for this character's slot
    const { error: upsertErr } = await supabase
      .from('player_cards')
      .upsert(
        { player_id: player.id, slot_index: slotIndex, rarity },
        { onConflict: 'player_id,slot_index' }
      );

    if (upsertErr) {
      console.error('player_cards upsert failed:', upsertErr);
      return interaction.editReply({ content: `Database error: ${upsertErr.message}` });
    }

    const pageNumber = Math.floor(slotIndex / 16) + 1;
    const positionOnPage = (slotIndex % 16) + 1;

    const embed = new EmbedBuilder()
      .setTitle(`${cardName} — ${RARITY_LABELS[rarity]}`)
      .setColor(RARITY_COLORS[rarity] || 0xf4c430)
      .setDescription(`Updated on **${player.name}**.`)
      .addFields(
        { name: 'Slot', value: `Page ${pageNumber}, position ${positionOnPage}`, inline: true },
        { name: 'Confidence', value: parsed.confidence || 'unknown', inline: true },
      );

    if (parsed.notes) embed.setFooter({ text: parsed.notes });

    return interaction.editReply({ embeds: [embed] });
  },
};

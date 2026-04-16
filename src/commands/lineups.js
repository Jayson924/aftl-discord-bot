const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const supabase = require('../supabase');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lineups')
    .setDescription('Show current raid lineups')
    .addStringOption(option =>
      option
        .setName('type')
        .setDescription('Filter by raid type')
        .addChoices(
          { name: 'Hardcore', value: 'Hardcore' },
          { name: 'Classic', value: 'Classic' },
          { name: '4-Man', value: '4-man' },
        ),
    ),

  async execute(interaction) {
    await interaction.deferReply();

    let query = supabase
      .from('lineups')
      .select(`
        *,
        lineup_players (
          player_name,
          slot_position,
          uses_ticket,
          pilot_name
        )
      `)
      .eq('is_template', false)
      .order('name');

    const raidType = interaction.options.getString('type');
    if (raidType) {
      query = query.eq('raid_type', raidType);
    }

    const { data: lineups, error } = await query;

    if (error) {
      console.error('Error fetching lineups:', error);
      return interaction.editReply({ content: 'Failed to fetch lineups from the database.', ephemeral: true });
    }

    if (!lineups || lineups.length === 0) {
      return interaction.editReply({ content: 'No lineups found.', ephemeral: true });
    }

    const embeds = lineups.map(lineup => {
      const lineupSize = lineup.raid_type === '4-man' ? 4 : 8;
      const players = Array(lineupSize).fill('');
      (lineup.lineup_players || [])
        .sort((a, b) => a.slot_position - b.slot_position)
        .forEach(lp => {
          const idx = lp.slot_position - 1;
          if (idx >= 0 && idx < lineupSize) {
            let display = lp.player_name || '_empty_';
            if (lp.pilot_name) display += ` (pilot: ${lp.pilot_name})`;
            if (lp.uses_ticket) display += ' 🎟️';
            players[idx] = display;
          }
        });

      const roster = players
        .map((p, i) => `\`${i + 1}.\` ${p || '_empty_'}`)
        .join('\n');

      const statusIcon = lineup.completed ? '✅' : lineup.status === 'ready' ? '🟢' : '⚪';

      return new EmbedBuilder()
        .setTitle(`${statusIcon} ${lineup.name}`)
        .setDescription(roster)
        .addFields(
          { name: 'Type', value: lineup.raid_type, inline: true },
          { name: 'Status', value: lineup.completed ? 'Completed' : lineup.status, inline: true },
        )
        .setColor(lineup.raid_type === 'Hardcore' ? 0xe74c3c : 0x3498db)
        .setFooter({ text: lineup.notes || ' ' });
    });

    // Discord allows max 10 embeds per message
    await interaction.editReply({ embeds: embeds.slice(0, 10) });
  },
};

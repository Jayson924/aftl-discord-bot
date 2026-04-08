const { SlashCommandBuilder, EmbedBuilder, ChannelType } = require('discord.js');
const supabase = require('../supabase');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('raidthread')
    .setDescription('Create a thread for a raid lineup and ping its players')
    .addStringOption(option =>
      option
        .setName('lineup')
        .setDescription('Name of the lineup')
        .setRequired(true),
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const lineupName = interaction.options.getString('lineup');

    // Fetch the lineup by name
    const { data: lineups, error } = await supabase
      .from('lineups')
      .select(`
        *,
        lineup_players (
          player_name,
          slot_position,
          player_id,
          uses_ticket,
          pilot_name
        )
      `)
      .ilike('name', lineupName)
      .limit(1);

    if (error) {
      console.error('Error fetching lineup:', error);
      return interaction.editReply({ content: 'Failed to fetch lineup from the database.' });
    }

    if (!lineups || lineups.length === 0) {
      return interaction.editReply({ content: `No lineup found with name "${lineupName}".` });
    }

    const lineup = lineups[0];

    // Look up discord IDs by player name
    const playerNames = (lineup.lineup_players || [])
      .map(lp => lp.player_name)
      .filter(Boolean);

    let discordMap = {};
    if (playerNames.length > 0) {
      const { data: players } = await supabase
        .from('players')
        .select('name, discord_id')
        .in('name', playerNames);

      if (players) {
        for (const p of players) {
          if (p.discord_id) discordMap[p.name] = p.discord_id;
        }
      }
    }

    // Build roster
    const allMentions = new Set();
    const slots = Array(8).fill('_empty_');
    (lineup.lineup_players || [])
      .sort((a, b) => a.slot_position - b.slot_position)
      .forEach(lp => {
        const idx = lp.slot_position - 1;
        if (idx >= 0 && idx < 8) {
          const discordId = discordMap[lp.player_name];
          let display;
          if (discordId) {
            allMentions.add(discordId);
            display = `<@${discordId}>`;
          } else {
            display = lp.player_name || '_empty_';
          }
          if (lp.pilot_name) display += ` (pilot: ${lp.pilot_name})`;
          if (lp.uses_ticket) display += ' 🎟️';
          slots[idx] = display;
        }
      });

    const roster = slots
      .map((p, i) => `\`${i + 1}.\` ${p}`)
      .join('\n');

    const embed = new EmbedBuilder()
      .setTitle(`${lineup.name} — ${lineup.raid_type}`)
      .setDescription(roster)
      .addFields(
        { name: 'Status', value: lineup.completed ? 'Completed' : lineup.status, inline: true },
      )
      .setColor(lineup.raid_type === 'Hardcore' ? 0xe74c3c : 0x3498db);

    // Create the thread
    const thread = await interaction.channel.threads.create({
      name: `${lineup.raid_type} — ${lineup.name}`,
      type: ChannelType.PublicThread,
      reason: `Raid thread for ${lineup.name}`,
    });

    // Post lineup embed in the thread
    await thread.send({ embeds: [embed] });

    // Ping players in the thread
    if (allMentions.size > 0) {
      const pingStr = [...allMentions].map(id => `<@${id}>`).join('\n');
      await thread.send(`${pingStr} Let's go!`);
    }

    await interaction.editReply({ content: `Thread created: ${thread}` });
  },
};

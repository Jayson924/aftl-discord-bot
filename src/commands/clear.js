const { SlashCommandBuilder } = require('discord.js');
const supabase = require('../supabase');
const { clearLineup, COMPLETED_TAG_NAME } = require('../lib/clearLineup');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Mark the lineup for this raid thread as cleared'),

  async execute(interaction) {
    const threadId = interaction.channel?.id;

    if (!interaction.channel?.isThread()) {
      return interaction.reply({ content: 'This command can only be used inside a raid thread.', ephemeral: true });
    }

    const { data: lineup, error } = await supabase
      .from('lineups')
      .select('id, name, raid_type, raid_time, completed')
      .eq('thread_id', threadId)
      .limit(1)
      .single();

    if (error || !lineup) {
      return interaction.reply({ content: 'No lineup found for this thread.', ephemeral: true });
    }

    if (lineup.completed) {
      return interaction.reply({ content: `**${lineup.name}** is already marked as cleared.`, ephemeral: true });
    }

    await interaction.deferReply();

    const result = await clearLineup({ lineup, raidThread: interaction.channel });

    if (result.updateError) {
      console.error('Failed to mark lineup as cleared:', result.updateError);
      return interaction.editReply({ content: 'Failed to update the lineup. Try again later.' });
    }

    const parts = [`**${lineup.name}** has been marked as cleared!`];
    if (result.tagged) parts.push(`Applied \`${COMPLETED_TAG_NAME}\` tag.`);
    if (result.lootThread) parts.push(`Loot thread: <#${result.lootThread.id}>`);
    else if (process.env.LOOT_CHANNEL_ID) parts.push('_(loot thread could not be created)_');

    await interaction.editReply(parts.join('\n'));
  },
};

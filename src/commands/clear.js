const { SlashCommandBuilder } = require('discord.js');
const supabase = require('../supabase');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Mark the lineup for this raid thread as cleared'),

  async execute(interaction) {
    const threadId = interaction.channel?.id;

    if (!interaction.channel?.isThread()) {
      return interaction.reply({ content: 'This command can only be used inside a raid thread.', ephemeral: true });
    }

    // Look up the lineup linked to this thread
    console.log('[Clear] Looking up lineup for thread_id:', threadId, typeof threadId);
    const { data: lineup, error } = await supabase
      .from('lineups')
      .select('id, name, completed')
      .eq('thread_id', threadId)
      .limit(1)
      .single();

    console.log('[Clear] Query result:', { lineup, error });

    if (error || !lineup) {
      return interaction.reply({ content: 'No lineup found for this thread.', ephemeral: true });
    }

    if (lineup.completed) {
      return interaction.reply({ content: `**${lineup.name}** is already marked as cleared.`, ephemeral: true });
    }

    const { error: updateError } = await supabase
      .from('lineups')
      .update({ completed: true })
      .eq('id', lineup.id);

    if (updateError) {
      console.error('Failed to mark lineup as cleared:', updateError);
      return interaction.reply({ content: 'Failed to update the lineup. Try again later.', ephemeral: true });
    }

    await interaction.reply(`**${lineup.name}** has been marked as cleared!`);
  },
};

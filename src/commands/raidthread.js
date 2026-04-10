const { SlashCommandBuilder } = require('discord.js');
const { createRaidThread } = require('../lib/createRaidThread');

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

    try {
      const { thread } = await createRaidThread({
        channel: interaction.channel,
        lineupName,
      });
      await interaction.editReply({ content: `Thread created: ${thread}` });
    } catch (err) {
      console.error('Error creating raid thread:', err);
      await interaction.editReply({ content: err.message || 'Failed to create thread.' });
    }
  },
};

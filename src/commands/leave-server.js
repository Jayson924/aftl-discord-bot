const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leave-server')
    .setDescription('swipe debugging')
    .addStringOption(option =>
      option
        .setName('guild_id')
        .setDescription('The ID of the server to leave')
        .setRequired(true),
    ),

  async execute(interaction) {
    if (interaction.user.id !== process.env.OWNER_ID) {
      await interaction.reply({ content: 'This command is restricted.', ephemeral: true });
      return;
    }

    const guildId = interaction.options.getString('guild_id').trim();
    const guild = interaction.client.guilds.cache.get(guildId);

    if (!guild) {
      await interaction.reply({ content: `Bot is not in a server with ID \`${guildId}\`.`, ephemeral: true });
      return;
    }

    const name = guild.name;
    try {
      await guild.leave();
      await interaction.reply({ content: `Left **${name}** (\`${guildId}\`).`, ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: `Failed to leave **${name}**: ${err.message}`, ephemeral: true });
    }
  },
};

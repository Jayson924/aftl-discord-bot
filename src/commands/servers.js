const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('servers')
    .setDescription('List servers the bot is installed on (owner only)'),

  async execute(interaction) {
    if (interaction.user.id !== process.env.OWNER_ID) {
      await interaction.reply({ content: 'This command is restricted.', ephemeral: true });
      return;
    }

    const guilds = interaction.client.guilds.cache;
    const lines = guilds
      .map(g => `- ${g.name} (${g.id}) — ${g.memberCount} members`)
      .join('\n');

    const content = `**${guilds.size} server(s):**\n${lines}`;
    await interaction.reply({
      content: content.length > 1900 ? content.slice(0, 1900) + '\n…(truncated)' : content,
      ephemeral: true,
    });
  },
};

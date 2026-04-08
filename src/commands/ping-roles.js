const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping-roles')
    .setDescription('Ping roles needed for a raid lineup')
    .addStringOption(option =>
      option
        .setName('roles')
        .setDescription('Comma-separated role names to ping (e.g. "Tank, Healer, DPS")')
        .setRequired(true),
    ),

  async execute(interaction) {
    const rolesInput = interaction.options.getString('roles');
    const roleNames = rolesInput.split(',').map(r => r.trim().toLowerCase());

    const guild = interaction.guild;
    const matched = [];
    const notFound = [];

    for (const name of roleNames) {
      const role = guild.roles.cache.find(r => r.name.toLowerCase() === name);
      if (role) {
        matched.push(role);
      } else {
        notFound.push(name);
      }
    }

    const parts = [];
    if (matched.length > 0) {
      parts.push(matched.map(r => `${r}`).join(' '));
      parts.push('You are needed for an upcoming raid!');
    }
    if (notFound.length > 0) {
      parts.push(`Could not find roles: ${notFound.join(', ')}`);
    }

    await interaction.reply(parts.join('\n'));
  },
};

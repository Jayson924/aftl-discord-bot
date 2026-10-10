const { SlashCommandBuilder } = require('discord.js');
const { DEFAULT_LEVEL, FD_DIVISOR, fdToPercent, fdForPercent } = require('../lib/finalDamage');

const LEVELS = Object.keys(FD_DIVISOR).map(Number);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('fd')
    .setDescription('Convert a raw FD value to a percentage, or a percentage to the raw FD needed')
    .addStringOption(option =>
      option
        .setName('value')
        .setDescription('Raw FD (e.g. 3762) or a percentage (e.g. 45%)')
        .setRequired(true),
    )
    .addIntegerOption(option =>
      option
        .setName('level')
        .setDescription(`Character level (default ${DEFAULT_LEVEL})`)
        .setMinValue(Math.min(...LEVELS))
        .setMaxValue(Math.max(...LEVELS)),
    ),

  async execute(interaction) {
    const input = interaction.options.getString('value').trim();
    const level = interaction.options.getInteger('level') ?? DEFAULT_LEVEL;
    const cap = FD_DIVISOR[level];

    if (input.endsWith('%')) {
      const pct = parseFloat(input);
      if (isNaN(pct) || pct <= 0 || pct > 60) {
        await interaction.reply('Please provide a percentage between 1% and 60% (e.g. `45%`).');
        return;
      }
      const raw = Math.ceil(fdForPercent(pct, level));
      await interaction.reply(`**${pct}%** FD at Lv${level} needs **${raw}** raw FD (60% at ${cap}).`);
      return;
    }

    const value = parseInt(input.replace(/,/g, ''), 10);
    if (isNaN(value) || value < 0) {
      await interaction.reply('Please provide a raw FD number or a percentage (e.g. `3762` or `45%`).');
      return;
    }

    const pct = fdToPercent(value, level);
    await interaction.reply(`**${value}** raw FD at Lv${level} → **${pct.toFixed(1)}%** FD (60% at ${cap}).`);
  },
};

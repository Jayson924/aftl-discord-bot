const { SlashCommandBuilder } = require('discord.js');
const supabase = require('../supabase');

async function getFdTable() {
  const { data, error } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'fd_table')
    .single();

  if (error || !data) return null;
  return data.value;
}

function lookupFd(fdTable, value) {
  for (let i = fdTable.length - 1; i >= 0; i--) {
    if (value >= fdTable[i].fd) {
      return fdTable[i].pct;
    }
  }
  return null;
}

function lookupByPct(fdTable, pct) {
  const entry = fdTable.find(e => e.pct === pct);
  return entry ? entry.fd : null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('fd')
    .setDescription('Look up FD percentage from a value, or value from a percentage (e.g. 1359 or 40%)')
    .addStringOption(option =>
      option
        .setName('value')
        .setDescription('A 4-digit number (e.g. 1359) or a percentage (e.g. 40%)')
        .setRequired(true),
    ),

  async execute(interaction) {
    const input = interaction.options.getString('value').trim();

    const fdTable = await getFdTable();
    if (!fdTable) {
      await interaction.reply('Failed to load FD table from database.');
      return;
    }

    fdTable.sort((a, b) => a.fd - b.fd);

    if (input.endsWith('%')) {
      const pct = parseInt(input, 10);
      if (isNaN(pct) || pct < 1 || pct > 100) {
        await interaction.reply('Please provide a valid percentage (e.g. `40%`).');
        return;
      }

      const val = lookupByPct(fdTable, pct);
      if (val === null) {
        await interaction.reply(`No data for **${pct}%**.`);
        return;
      }

      await interaction.reply(`**${pct}%** → lowest number seen **${val}**`);
      return;
    }

    const value = parseInt(input, 10);
    if (isNaN(value) || value < 1000 || value > 9999) {
      await interaction.reply('Please provide a 4-digit number or a percentage (e.g. `1359` or `40%`).');
      return;
    }

    const pct = lookupFd(fdTable, value);
    if (pct === null) {
      const min = fdTable[0];
      await interaction.reply(`**${value}** is below the minimum threshold (${min.fd} = ${min.pct}%).`);
      return;
    }

    await interaction.reply(`**${value}** → **${pct}%** FD`);
  },
};

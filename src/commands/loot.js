// /loot — log raid loot from the Discord loot thread into the shared
// `lineup_loot` table (source: 'discord'). The website reads the same table and
// a realtime subscription keeps both sides + the thread's tracker embed in sync.
//
//   /loot add    item:<name> [holder:<roster pick>]   → log an (unsold) item
//   /loot sold   item:<pick> price:<gold>             → mark an item sold
//   /loot remove item:<pick>                          → delete an entry
//   /loot list                                        → show the current loot
//
// Run inside the loot thread (or the raid thread); the lineup is resolved from
// the thread id.

const { SlashCommandBuilder } = require('discord.js');
const {
  fmtGold,
  getLineupByThread,
  getRoster,
  getRosterDisplay,
  getLootRows,
  insertLootEntry,
  updateLootEntry,
  deleteLootEntry,
  buildLootEmbed,
  updateLootMessage,
} = require('../lib/lootThread');

// Resolve a user-supplied item option (ideally a loot id from autocomplete, but
// could be free-typed text) to a loot row.
function resolveLootRow(lootRows, value, { unsoldOnly = false } = {}) {
  if (!value) return null;
  const byId = lootRows.find(l => l.id === value);
  if (byId) return byId;
  const lower = value.trim().toLowerCase();
  const matches = lootRows.filter(l => l.item.toLowerCase() === lower);
  const pool = unsoldOnly ? matches.filter(l => !l.sold) : matches;
  return pool[0] || matches[0] || null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('loot')
    .setDescription('Log and track loot for this raid')
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('Log a loot item (unsold)')
        .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true).setMaxLength(200))
        .addStringOption(o =>
          o.setName('holder').setDescription('Who is holding it (party member)').setAutocomplete(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('sold')
        .setDescription('Mark a logged item as sold')
        .addStringOption(o =>
          o.setName('item').setDescription('Which item sold').setRequired(true).setAutocomplete(true)
        )
        .addIntegerOption(o =>
          o.setName('price').setDescription('Sale price in gold').setRequired(true).setMinValue(0)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription('Delete a loot entry')
        .addStringOption(o =>
          o.setName('item').setDescription('Which entry to remove').setRequired(true).setAutocomplete(true)
        )
    )
    .addSubcommand(sub => sub.setName('list').setDescription('Show the current loot for this raid')),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const lineup = await getLineupByThread(interaction.channel?.id);
    if (!lineup) return interaction.respond([]);

    const query = (focused.value || '').toLowerCase();

    if (focused.name === 'holder') {
      const roster = await getRoster(lineup.id, lineup.raid_type);
      const choices = roster
        .filter(n => n.toLowerCase().includes(query))
        .slice(0, 25)
        .map(n => ({ name: n, value: n }));
      return interaction.respond(choices);
    }

    if (focused.name === 'item') {
      const sub = interaction.options.getSubcommand();
      let rows = await getLootRows(lineup.id);
      if (sub === 'sold') rows = rows.filter(l => !l.sold); // only unsold can be marked sold
      const choices = rows
        .filter(l => l.item.toLowerCase().includes(query))
        .slice(0, 25)
        .map(l => {
          const status = l.sold ? `🪙${fmtGold(l.price)}` : 'not yet sold';
          const holder = l.heldBy ? ` · ${l.heldBy}` : '';
          return { name: `${l.item} (${status}${holder})`.slice(0, 100), value: l.id };
        });
      return interaction.respond(choices);
    }

    return interaction.respond([]);
  },

  async execute(interaction) {
    if (!interaction.channel?.isThread()) {
      return interaction.reply({ content: 'Use `/loot` inside a raid or loot thread.', ephemeral: true });
    }

    const lineup = await getLineupByThread(interaction.channel.id);
    if (!lineup) {
      return interaction.reply({ content: 'No lineup is linked to this thread.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();

    try {
      if (sub === 'add') {
        const item = interaction.options.getString('item').trim();
        const holder = interaction.options.getString('holder')?.trim() || '';
        if (!item) return interaction.reply({ content: 'Item name is required.', ephemeral: true });

        await insertLootEntry(lineup.id, { item, heldBy: holder, createdBy: interaction.user.id });
        await updateLootMessage(interaction.client, lineup.id);
        return interaction.reply(
          `➕ Logged **${item}**${holder ? ` — held by **${holder}**` : ''} _(unsold)_.`
        );
      }

      if (sub === 'sold') {
        const value = interaction.options.getString('item');
        const price = interaction.options.getInteger('price');
        const [rows, rosterDisplay] = await Promise.all([
          getLootRows(lineup.id),
          getRosterDisplay(lineup.id, lineup.raid_type),
        ]);
        const row = resolveLootRow(rows, value, { unsoldOnly: true });
        if (!row) {
          return interaction.reply({ content: `Couldn't find a loot entry matching that. Pick one from the list.`, ephemeral: true });
        }
        // Whoever marks it sold becomes the holder — their roster character if
        // they're in the party, otherwise their Discord display name.
        const sellerName = rosterDisplay.find(r => r.discordId === interaction.user.id)?.name
          || interaction.member?.displayName
          || interaction.user.username;
        await updateLootEntry(row.id, { sold: true, price, heldBy: sellerName });
        await updateLootMessage(interaction.client, lineup.id);
        return interaction.reply(`💰 **${row.item}** sold for 🪙 **${fmtGold(price)}** — held by **${sellerName}**.`);
      }

      if (sub === 'remove') {
        const value = interaction.options.getString('item');
        const rows = await getLootRows(lineup.id);
        const row = resolveLootRow(rows, value);
        if (!row) {
          return interaction.reply({ content: `Couldn't find a loot entry matching that. Pick one from the list.`, ephemeral: true });
        }
        await deleteLootEntry(row.id);
        await updateLootMessage(interaction.client, lineup.id);
        return interaction.reply(`🗑️ Removed **${row.item}**.`);
      }

      if (sub === 'list') {
        const [rows, rosterDisplay] = await Promise.all([
          getLootRows(lineup.id),
          getRosterDisplay(lineup.id, lineup.raid_type),
        ]);
        return interaction.reply({
          embeds: [buildLootEmbed(lineup, rows, rosterDisplay, { raidThreadId: lineup.thread_id })],
          ephemeral: true,
        });
      }
    } catch (err) {
      console.error('[loot] command error:', err);
      const msg = { content: 'Something went wrong updating the loot.', ephemeral: true };
      if (interaction.replied || interaction.deferred) return interaction.followUp(msg).catch(() => {});
      return interaction.reply(msg).catch(() => {});
    }
  },
};

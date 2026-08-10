// /loot — log raid loot from the Discord loot thread into the shared
// `lineup_loot` table (source: 'discord'). The website reads the same table and
// a realtime subscription keeps both sides + the thread's tracker embed in sync.
//
//   /loot add    item:<name> [holder:<roster pick>]   → log an (unsold) item
//   /loot sold   item:<pick> price:<gold>             → mark an item sold
//   /loot remove item:<pick>                          → delete an entry
//   /loot list                                        → show the current loot
//   /loot payout                                      → post/repost the ✅ gold-share message
//
// Run inside the loot thread (or the raid thread); the lineup is resolved from
// the thread id.

const { SlashCommandBuilder } = require('discord.js');
const {
  fmtGold,
  resolveParentByThread,
  getRoster,
  getRosterDisplay,
  getLootRows,
  insertLootEntry,
  updateLootEntry,
  deleteLootEntry,
  buildLootEmbed,
  updateLootMessage,
} = require('../lib/lootThread');
const { refreshPayoutState } = require('../lib/lootPayout');

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
    .addSubcommand(sub => sub.setName('list').setDescription('Show the current loot for this raid'))
    .addSubcommand(sub =>
      sub
        .setName('payout')
        .setDescription("Post (or re-post) the 'react ✅ for your gold share' message in the loot thread")
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const parent = await resolveParentByThread(interaction.channel?.id);
    if (!parent) return interaction.respond([]);

    const query = (focused.value || '').toLowerCase();

    if (focused.name === 'holder') {
      const roster = await getRoster(parent);
      const choices = roster
        .filter(n => n.toLowerCase().includes(query))
        .slice(0, 25)
        .map(n => ({ name: n, value: n }));
      return interaction.respond(choices);
    }

    if (focused.name === 'item') {
      const sub = interaction.options.getSubcommand();
      let rows = await getLootRows(parent);
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

    const parent = await resolveParentByThread(interaction.channel.id);
    if (!parent) {
      return interaction.reply({ content: 'No lineup or loot record is linked to this thread.', ephemeral: true });
    }
    const embedLineup = { name: parent.name, raid_type: parent.raidType };

    const sub = interaction.options.getSubcommand();

    try {
      if (sub === 'add') {
        const item = interaction.options.getString('item').trim();
        const holder = interaction.options.getString('holder')?.trim() || '';
        if (!item) return interaction.reply({ content: 'Item name is required.', ephemeral: true });

        await insertLootEntry(parent, { item, heldBy: holder, createdBy: interaction.user.id });
        await updateLootMessage(interaction.client, parent);
        return interaction.reply(
          `➕ Logged **${item}**${holder ? ` — held by **${holder}**` : ''} _(unsold)_.`
        );
      }

      if (sub === 'sold') {
        const value = interaction.options.getString('item');
        const price = interaction.options.getInteger('price');
        const [rows, rosterDisplay] = await Promise.all([
          getLootRows(parent),
          getRosterDisplay(parent),
        ]);
        const row = resolveLootRow(rows, value, { unsoldOnly: true });
        if (!row) {
          return interaction.reply({ content: `Couldn't find a loot entry matching that. Pick one from the list.`, ephemeral: true });
        }
        // Whoever marks it sold becomes the holder — their roster character if
        // they're in the party (as owner or pilot), otherwise their Discord name.
        const sellerName = rosterDisplay.find(r => r.discordId === interaction.user.id || r.ownerDiscordId === interaction.user.id)?.name
          || interaction.member?.displayName
          || interaction.user.username;
        await updateLootEntry(row.id, { sold: true, price, heldBy: sellerName });
        await updateLootMessage(interaction.client, parent);
        return interaction.reply(`💰 **${row.item}** sold for 🪙 **${fmtGold(price)}** — held by **${sellerName}**.`);
      }

      if (sub === 'remove') {
        const value = interaction.options.getString('item');
        const rows = await getLootRows(parent);
        const row = resolveLootRow(rows, value);
        if (!row) {
          return interaction.reply({ content: `Couldn't find a loot entry matching that. Pick one from the list.`, ephemeral: true });
        }
        await deleteLootEntry(row.id);
        await updateLootMessage(interaction.client, parent);
        return interaction.reply(`🗑️ Removed **${row.item}**.`);
      }

      if (sub === 'list') {
        const [rows, rosterDisplay] = await Promise.all([
          getLootRows(parent),
          getRosterDisplay(parent),
        ]);
        return interaction.reply({
          embeds: [buildLootEmbed(embedLineup, rows, rosterDisplay, { raidThreadId: parent.threadId })],
          ephemeral: true,
        });
      }

      if (sub === 'payout') {
        // Manual escape hatch: normally the payout message posts itself the moment
        // the last item sells. It can't when the loot thread changed underneath it
        // (an un-clear → re-clear spins up a NEW thread while payout_message_id
        // still points into the old one) or when the message was deleted. Forcing
        // it posts a fresh one in the lineup's CURRENT loot thread and re-links it.
        await interaction.deferReply({ ephemeral: true });
        // Re-sync the tracker embed too — a thread that was created after the loot
        // was logged starts out showing an empty list.
        await updateLootMessage(interaction.client, parent).catch(err =>
          console.error('[loot] payout embed refresh failed:', err.message));
        const result = await refreshPayoutState(interaction.client, parent, { canPost: true, force: true });

        if (result.status !== 'posted' && result.status !== 'updated') {
          const why = {
            'no-thread': "This raid has no loot thread linked, so there's nowhere to post the payout message.",
            'nothing-sold': 'Nothing has been marked sold yet — log the sale with `/loot sold` first, then run this again.',
            'send-failed': "Couldn't post in this thread — check my permissions here.",
          }[result.status] || 'Nothing to post yet.';
          return interaction.editReply(why);
        }

        const lines = [
          result.status === 'posted'
            ? `${result.replaced ? '♻️ Re-posted' : '✅ Posted'} the gold-share message: ${result.messageUrl}`
            : `🔄 Refreshed the gold-share message: ${result.messageUrl}`,
          `🪙 **${fmtGold(result.total)}** total · 🪙 **${fmtGold(result.payoutEach)}** each _(÷${result.partySize})_`,
        ];
        if (result.reopened) lines.push('_The payout had already been closed — re-opened it._');
        if (result.unsoldCount > 0) {
          lines.push(
            `⚠️ **${result.unsoldCount}** item${result.unsoldCount === 1 ? '' : 's'} still unsold — ` +
            'anyone who confirms now will be asked for the difference once those sell.'
          );
        }
        return interaction.editReply(lines.join('\n'));
      }
    } catch (err) {
      console.error('[loot] command error:', err);
      const msg = { content: 'Something went wrong updating the loot.', ephemeral: true };
      if (interaction.replied || interaction.deferred) return interaction.followUp(msg).catch(() => {});
      return interaction.reply(msg).catch(() => {});
    }
  },
};

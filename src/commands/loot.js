// /loot — log raid loot from the Discord loot thread into the shared
// `lineup_loot` table (source: 'discord'). The website reads the same table and
// a realtime subscription keeps both sides + the thread's tracker embed in sync.
//
//   /loot add    item:<name> [holder:<roster pick>]   → log an (unsold) item
//   /loot sold   item:<pick> price:<gold>             → mark an item sold
//   /loot remove item:<pick>                          → delete an entry
//   /loot list                                        → show the current loot
//   /loot payout [raid:<pick>]                        → post/repost the ✅ gold-share message
//
// Run inside the loot thread (or the raid thread); the lineup is resolved from
// the thread id. `/loot payout` additionally accepts an explicit `raid:` pick so
// it works from a thread that isn't linked to anything (see ensureLootThread).

const { SlashCommandBuilder } = require('discord.js');
const supabase = require('../supabase');
const {
  fmtGold,
  resolveParentByThread,
  resolveParentById,
  updateParentBookkeeping,
  toRef,
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
const { createLootThread } = require('../lib/clearLineup');

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

// `raid:` autocomplete values are prefixed so a live lineup and an archived loot
// record can share one picker.
function refFromChoice(value) {
  if (!value) return null;
  if (value.startsWith('rec:')) return { recordId: value.slice(4) };
  if (value.startsWith('lin:')) return { lineupId: value.slice(4) };
  return { lineupId: value }; // bare id (someone typed/pasted one)
}

// Raids to choose from in `/loot payout raid:` — recent lineups + archived
// records, newest first.
async function raidChoices(query) {
  const [lineups, records] = await Promise.all([
    supabase.from('lineups')
      .select('id, name, raid_type, completed, created_at')
      .eq('is_template', false)
      .order('created_at', { ascending: false })
      .limit(40),
    supabase.from('loot_records')
      .select('id, lineup_name, raid_type, cleared_at')
      .order('cleared_at', { ascending: false })
      .limit(20),
  ]);

  const choices = [];
  for (const l of lineups.data || []) {
    if (!(l.name || '').toLowerCase().includes(query)) continue;
    choices.push({ name: `${l.name} (${l.raid_type})`.slice(0, 100), value: `lin:${l.id}` });
  }
  for (const r of records.data || []) {
    if (!(r.lineup_name || '').toLowerCase().includes(query)) continue;
    choices.push({ name: `${r.lineup_name} (${r.raid_type} · archived)`.slice(0, 100), value: `rec:${r.id}` });
  }
  return choices.slice(0, 25);
}

/**
 * Make sure `parent` has a loot thread the bot can actually post in — the whole
 * point of `/loot payout` is that it never dead-ends.
 *
 *  - linked thread still exists → use it (nothing to do)
 *  - run inside a thread in the loot channel → adopt THAT thread (post/refresh
 *    the tracker embed there and re-link it). This is how you point a raid back
 *    at an older loot thread, or at a screenshot-made one that lost its link.
 *    Passing `raid:` explicitly means "use this thread" even if another is linked.
 *  - otherwise (run from the raid thread) → create a proper loot thread.
 *
 * @returns {Promise<{ok: boolean, parent?: Object, note?: string, error?: string}>}
 */
async function ensureLootThread(interaction, parent, { adopt = false } = {}) {
  const channel = interaction.channel;
  const lootChannelId = process.env.LOOT_CHANNEL_ID;
  const inLootChannel = !!lootChannelId && channel.parentId === lootChannelId;

  const linked = parent.lootThreadId
    ? await interaction.client.channels.fetch(parent.lootThreadId).catch(() => null)
    : null;

  // An explicit `raid:` pick from inside a loot-channel thread means "this one".
  const wantsAdopt = adopt && inLootChannel && (!linked || linked.id !== channel.id);
  if (linked && !wantsAdopt) return { ok: true, parent };

  const reason = !parent.lootThreadId
    ? 'no loot thread was linked'
    : (linked ? 'moved on request' : "the linked loot thread is gone (deleted, or I can't see it)");

  if (inLootChannel) {
    const [rosterDisplay, lootRows] = await Promise.all([getRosterDisplay(parent), getLootRows(parent)]);
    const embed = buildLootEmbed(
      { name: parent.name, raid_type: parent.raidType },
      lootRows,
      rosterDisplay,
      { raidThreadId: parent.threadId }
    );

    // Reuse the tracker message if this thread already has ours; else post one.
    let trackerId = null;
    if (parent.lootMessageId) {
      const existing = await channel.messages.fetch(parent.lootMessageId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [embed] }).catch(() => {});
        trackerId = existing.id;
      }
    }
    if (!trackerId) {
      // The bookkeeping may point at a message in a thread we've lost, while THIS
      // thread still holds an orphaned tracker from before (e.g. a screenshot
      // thread whose link got overwritten). Re-adopt it instead of posting a dupe.
      const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
      const mine = recent?.find(m =>
        m.author?.id === interaction.client.user?.id && m.embeds?.[0]?.title === `${parent.name} — Loot`
      );
      if (mine) {
        await mine.edit({ embeds: [embed] }).catch(() => {});
        trackerId = mine.id;
      }
    }
    if (!trackerId) {
      const posted = await channel.send({ embeds: [embed] }).catch(err => {
        console.error('[loot] tracker post failed:', err.message);
        return null;
      });
      if (!posted) return { ok: false, error: "I can't post in this thread — check my permissions here." };
      trackerId = posted.id;
    }

    await updateParentBookkeeping(parent, {
      loot_thread_id: channel.id,
      loot_message_id: trackerId,
      payout_message_id: null,
      loot_close_at: null,
      loot_closed: false,
    });

    return {
      ok: true,
      parent: await resolveParentById(toRef(parent)),
      note: `🔗 Linked this thread as the loot thread for **${parent.name}** (${reason}).`,
    };
  }

  if (parent.kind !== 'lineup') {
    return { ok: false, error: `The loot thread for **${parent.name}** is gone. Run this inside the thread you want to use instead, with \`raid:\`.` };
  }

  // Not in the loot channel (so: the raid thread) → spin up a real loot thread.
  const { data: row } = await supabase
    .from('lineups')
    .select('id, name, raid_type, raid_time')
    .eq('id', parent.id)
    .maybeSingle();
  const created = await createLootThread(row || { id: parent.id, name: parent.name, raid_type: parent.raidType }, channel)
    .catch(err => { console.error('[loot] loot thread create failed:', err.message); return null; });
  if (!created) {
    return { ok: false, error: `No loot thread is linked to **${parent.name}** and I couldn't create one. Run this inside the thread you want to use, with \`raid:\`.` };
  }

  return {
    ok: true,
    parent: await resolveParentById(toRef(parent)),
    note: `🧵 Created the loot thread: <#${created.id}> (${reason}).`,
  };
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
        .addStringOption(o =>
          o
            .setName('raid')
            .setDescription('Only if this thread is not linked yet — picks the raid and makes this its loot thread')
            .setAutocomplete(true)
        )
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const query = (focused.value || '').toLowerCase();

    // The raid picker is the one option that must work in an UNLINKED thread —
    // resolve it before the thread lookup below bails out.
    if (focused.name === 'raid') {
      return interaction.respond(await raidChoices(query).catch(() => []));
    }

    const parent = await resolveParentByThread(interaction.channel?.id);
    if (!parent) return interaction.respond([]);

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

    const sub = interaction.options.getSubcommand();
    // `/loot payout raid:<pick>` names its raid outright, so it works from a
    // thread that isn't linked to anything yet.
    const raidChoice = sub === 'payout' ? interaction.options.getString('raid') : null;

    let parent = raidChoice
      ? await resolveParentById(refFromChoice(raidChoice))
      : await resolveParentByThread(interaction.channel.id);
    if (!parent) {
      return interaction.reply({
        content: raidChoice
          ? "Couldn't find that raid — pick one from the list."
          : 'No lineup or loot record is linked to this thread.'
            + (sub === 'payout' ? ' Add `raid:` to pick the raid and make this thread its loot thread.' : ''),
        ephemeral: true,
      });
    }
    const embedLineup = { name: parent.name, raid_type: parent.raidType };

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

        // Guarantee a usable loot thread first (adopt this one / create one),
        // otherwise there's nowhere to post and the command dead-ends.
        const prep = await ensureLootThread(interaction, parent, { adopt: !!raidChoice });
        if (!prep.ok) return interaction.editReply(prep.error);
        parent = prep.parent || parent;

        // Re-sync the tracker embed too — a thread that was created after the loot
        // was logged starts out showing an empty list.
        await updateLootMessage(interaction.client, parent).catch(err =>
          console.error('[loot] payout embed refresh failed:', err.message));
        const result = await refreshPayoutState(interaction.client, parent, { canPost: true, force: true });

        if (result.status !== 'posted' && result.status !== 'updated') {
          const why = {
            'no-thread': "This raid has no loot thread linked, so there's nowhere to post the payout message.",
            'thread-missing': "The linked loot thread is gone. Run this inside the thread you want to use, with `raid:`.",
            'nothing-sold': 'Nothing has been marked sold yet — log the sale with `/loot sold` first, then run this again.',
            'send-failed': "Couldn't post in this thread — check my permissions here.",
          }[result.status] || 'Nothing to post yet.';
          return interaction.editReply([prep.note, why].filter(Boolean).join('\n'));
        }

        const lines = [
          prep.note,
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
        return interaction.editReply(lines.filter(Boolean).join('\n'));
      }
    } catch (err) {
      console.error('[loot] command error:', err);
      const msg = { content: 'Something went wrong updating the loot.', ephemeral: true };
      if (interaction.replied || interaction.deferred) return interaction.followUp(msg).catch(() => {});
      return interaction.reply(msg).catch(() => {});
    }
  },
};

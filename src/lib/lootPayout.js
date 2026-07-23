// Gold-share payout confirmations.
//
// When every logged item for a cleared lineup is sold, the payout-per-person is
// final. The bot posts a "react ✅ when you've got your share" message in the
// loot thread and pings the linked party members. Each member confirms by
// reacting ✅ (or ticking the checkbox on the website — both write the shared
// `lineup_payouts` table). Once every LINKED party member (slots owned by a
// Discord account; guests/unlinked are excluded) has confirmed, the thread is
// scheduled to archive 3 hours later — a 1-minute sweeper does the archiving so
// it survives a bot restart.
//
// lineup_payouts columns: id, lineup_id, member_name, discord_id, source
//   ('web'|'discord'), created_by, received_at. UNIQUE(lineup_id, member_name).
// Bookkeeping on lineups: payout_message_id, loot_close_at, loot_closed.

const supabase = require('../supabase');
const {
  getRosterDisplay,
  getLootRows,
  fmtGold,
  resolveParentById,
  resolveParentByPayoutMessage,
  refFromLootPayload,
  updateParentBookkeeping,
  parentCol,
  toRef,
} = require('./lootThread');

const PAYOUT_EMOJI = '✅';
const CLOSE_DELAY_MS = 3 * 60 * 60 * 1000; // 3 hours
const SWEEP_INTERVAL_MS = 60 * 1000;       // check for due closes every minute

// Escape Discord markdown so item / holder text renders literally.
function escapeMd(str) {
  return String(str ?? '').replace(/([\\*_~`|>])/g, '\\$1');
}

// ============================================
// DATA HELPERS
// ============================================

async function getPayoutRows(parent) {
  const { data, error } = await supabase
    .from('lineup_payouts')
    .select('member_name, discord_id, amount')
    .eq(parentCol(parent), parent.id);
  if (error) {
    console.error('[payout] getPayoutRows failed:', error.message);
    return [];
  }
  return (data || []).map(p => ({ ...p, amount: Number(p.amount) || 0 }));
}

// `amount` = the gold this member has now withdrawn (the current per-person share).
async function upsertPayout(parent, memberName, discordId, amount = 0) {
  const col = parentCol(parent);
  const row = {
    member_name: memberName,
    discord_id: discordId || null,
    source: 'discord',
    created_by: discordId || null,
    received_at: new Date().toISOString(),
    amount: Math.max(0, Math.round(Number(amount) || 0)),
  };
  row[col] = parent.id;
  const { error } = await supabase
    .from('lineup_payouts')
    .upsert(row, { onConflict: `${col},member_name` });
  if (error) throw error;
}

// Compute the current per-person payout for a parent from its sold loot.
async function computePayoutEach(parent, partySize) {
  const lootRows = await getLootRows(parent);
  const total = lootRows.reduce((s, l) => s + (l.sold ? l.price : 0), 0);
  return partySize > 0 ? Math.floor(total / partySize) : 0;
}

// Suppress the payout-deletion that a bot-initiated reaction removal would
// otherwise trigger (we remove stale ✅ during a top-up but keep the amount).
const suppressedRemovals = new Set();
const removalKey = (messageId, userId) => `${messageId}:${userId}`;

async function deletePayoutsForMembers(parent, memberNames) {
  if (!memberNames.length) return;
  const { error } = await supabase
    .from('lineup_payouts')
    .delete()
    .eq(parentCol(parent), parent.id)
    .in('member_name', memberNames);
  if (error) throw error;
}

// ============================================
// MESSAGE CONTENT
// ============================================

// `paidMap` = Map(member_name → gold withdrawn). A member is settled when they've
// withdrawn >= the current payoutEach; "partial" when they withdrew a smaller
// prior share and now owe the difference (a forgotten item was sold after they
// confirmed).
function memberPayState(name, paidMap, payoutEach) {
  if (!paidMap.has(name)) return { settled: false, partial: false, withdrawn: 0 };
  const w = paidMap.get(name);
  if (w >= payoutEach) return { settled: true, partial: false, withdrawn: w };
  if (w > 0) return { settled: false, partial: true, withdrawn: w };
  return { settled: false, partial: false, withdrawn: 0 };
}

function buildPayoutContent(rosterDisplay, paidMap, total, payoutEach, closeAt, closed) {
  const partySize = rosterDisplay.length;
  const linked = rosterDisplay.filter(r => r.discordId);

  const lines = linked.map(m => {
    const st = memberPayState(m.name, paidMap, payoutEach);
    const pilotTag = m.isPilot ? ' _(pilot)_' : '';
    if (st.settled) return `✅ ~~${escapeMd(m.name)}~~ — <@${m.discordId}>${pilotTag}`;
    if (st.partial) {
      const owed = Math.max(0, payoutEach - st.withdrawn);
      return `🔸 **${escapeMd(m.name)}** — <@${m.discordId}>${pilotTag} · already withdrew 🪙 ${fmtGold(st.withdrawn)}, grab **+🪙 ${fmtGold(owed)}**`;
    }
    return `⬜ **${escapeMd(m.name)}** — <@${m.discordId}>${pilotTag}`;
  });
  // Guests / unlinked members an editor marked paid on the website (settled only)
  const extras = rosterDisplay
    .filter(r => !r.discordId && memberPayState(r.name, paidMap, payoutEach).settled)
    .map(m => `✅ ~~${escapeMd(m.name)}~~ _(guest)_`);

  const anyPartial = linked.some(m => memberPayState(m.name, paidMap, payoutEach).partial);
  const header =
    `💰 **Loot sold — 🪙 ${fmtGold(total)} total · 🪙 ${fmtGold(payoutEach)} each** _(÷${partySize})_\n` +
    (anyPartial
      ? `More loot was sold. If you already got your earlier share, just grab the **+difference** shown below, then re-react ${PAYOUT_EMOJI}.`
      : `React ${PAYOUT_EMOJI} once you've received your gold share.`);

  const body = [...lines, ...extras].join('\n') || '_no linked party members_';

  let footer = '';
  if (closed) {
    footer = `\n\n🔒 Everyone's confirmed — thread closed.`;
  } else if (closeAt) {
    const unix = Math.floor(closeAt.getTime() / 1000);
    footer = `\n\n✅ Everyone's confirmed — this thread will archive <t:${unix}:R>.`;
  }

  return `${header}\n\n${body}${footer}`;
}

// ============================================
// CORE: post / update the payout message + manage the auto-close window
// ============================================
//
// canPost: only the loot-change path (onLootChanged) may CREATE the message —
// this keeps message creation single-sourced (the moment the last item sells),
// so the payout-sync and reaction paths can't race and double-post. Those paths
// only ever edit an existing message + manage the close timer.

// `ref` is a { lineupId } / { recordId } ref, a parent object, or a legacy lineup
// id. Re-resolves a fresh parent so bookkeeping is current.
async function refreshPayoutState(client, ref, { canPost = false } = {}) {
  const parent = await resolveParentById(toRef(ref));
  if (!parent || !parent.lootThreadId) return;

  const [lootRows, rosterDisplay, payoutRows] = await Promise.all([
    getLootRows(parent),
    getRosterDisplay(parent),
    getPayoutRows(parent),
  ]);

  const partySize = rosterDisplay.length;
  const total = lootRows.reduce((s, l) => s + (l.sold ? l.price : 0), 0);
  const payoutEach = partySize > 0 ? Math.floor(total / partySize) : 0;
  const allSold = lootRows.length > 0 && lootRows.every(l => l.sold);
  const shouldExist = allSold && total > 0;

  const hasMessage = !!parent.payoutMessageId;
  // Nothing to do yet: no message and either not allowed to post or not all sold.
  if (!hasMessage && (!canPost || !shouldExist)) return;

  // name → gold withdrawn. Settled = withdrew >= the current payout-each.
  const paidMap = new Map(payoutRows.map(p => [p.member_name, p.amount]));
  const isSettled = (name) => paidMap.has(name) && paidMap.get(name) >= payoutEach;
  const linked = rosterDisplay.filter(r => r.discordId);
  const allConfirmed = linked.length > 0 && linked.every(m => isSettled(m.name));
  // Only close once everything's actually sold AND everyone's settled at the
  // current share. A forgotten item raising the share re-opens things.
  const readyToClose = allSold && allConfirmed;

  // Manage the 3-hour auto-close window.
  let closeAt = parent.lootCloseAt ? new Date(parent.lootCloseAt) : null;
  const updates = {};
  if (!parent.lootClosed) {
    if (readyToClose && !closeAt) {
      closeAt = new Date(Date.now() + CLOSE_DELAY_MS);
      updates.loot_close_at = closeAt.toISOString();
    } else if (!readyToClose && closeAt) {
      // Un-confirmed, a new linked member appeared, or new loot raised the share —
      // cancel the pending close.
      closeAt = null;
      updates.loot_close_at = null;
    }
  }

  const thread = await client.channels.fetch(parent.lootThreadId).catch(() => null);
  if (!thread) return;

  const content = buildPayoutContent(rosterDisplay, paidMap, total, payoutEach, closeAt, parent.lootClosed);

  let message = null;
  if (!hasMessage) {
    // First time everything's sold: post the confirm message (pings linked
    // members) and seed the ✅ reaction so members can just click it.
    message = await thread
      .send({ content, allowedMentions: { parse: ['users'] } })
      .catch(err => { console.error('[payout] send failed:', err.message); return null; });
    if (!message) return;
    await message.react(PAYOUT_EMOJI).catch(() => {});
    updates.payout_message_id = message.id;
  } else {
    message = await thread.messages.fetch(parent.payoutMessageId).catch(() => null);
    if (message) {
      await message
        .edit({ content, allowedMentions: { parse: [] } })
        .catch(err => console.error('[payout] edit failed:', err.message));
    }
  }

  if (Object.keys(updates).length) {
    await updateParentBookkeeping(parent, updates);
  }

  // A forgotten item was sold after some members confirmed → they're now "partial"
  // (withdrew a smaller prior share). Remove their stale ✅ so they must re-react
  // for the top-up. Guarded so this removal doesn't wipe their recorded amount.
  if (message && !parent.lootClosed) {
    const reaction = message.reactions.cache.get(PAYOUT_EMOJI);
    if (reaction) {
      for (const m of linked) {
        const st = memberPayState(m.name, paidMap, payoutEach);
        if (st.partial) {
          const key = removalKey(message.id, m.discordId);
          suppressedRemovals.add(key);
          await reaction.users.remove(m.discordId).catch(() => {});
          setTimeout(() => suppressedRemovals.delete(key), 5000);
        }
      }
    }
  }
}

// Called from the lineup_loot realtime sync (lootThread.startLootSync) after the
// loot embed is updated — this is the ONLY path allowed to create the message.
function onLootChanged(client, ref) {
  return refreshPayoutState(client, ref, { canPost: true }).catch(err =>
    console.error('[payout] onLootChanged failed:', err.message)
  );
}

// ============================================
// REACTION HANDLER
// ============================================

async function handlePayoutReaction(reaction, user, added) {
  if (!user || user.bot) return;
  const client = reaction.client || reaction.message?.client;
  if (!client) return;

  // Reactions on uncached messages arrive as partials — hydrate them first.
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message?.partial) await reaction.message.fetch();
  } catch (err) {
    console.error('[payout] reaction hydrate failed:', err.message);
    return;
  }

  if (reaction.emoji?.name !== PAYOUT_EMOJI) return;
  const messageId = reaction.message?.id;
  if (!messageId) return;

  // Ignore removals the bot itself made to reset a stale ✅ (top-up) — those must
  // NOT wipe the member's recorded withdrawn amount.
  if (!added && suppressedRemovals.has(removalKey(messageId, user.id))) return;

  // The payout message belongs to a live lineup or an archived loot record.
  const parent = await resolveParentByPayoutMessage(messageId);
  if (!parent) return; // not a payout message

  const rosterDisplay = await getRosterDisplay(parent);
  // The reactor may be the slot's PILOT (the responsible/tagged person) or its
  // owner — accept the ✅ from either.
  const myNames = rosterDisplay
    .filter(r => r.pilotDiscordId === user.id || r.ownerDiscordId === user.id)
    .map(r => r.name);
  if (myNames.length === 0) return; // reactor isn't linked to any party slot

  try {
    if (added) {
      // Confirming = they've now withdrawn the full current share.
      const payoutEach = await computePayoutEach(parent, rosterDisplay.length);
      for (const name of myNames) await upsertPayout(parent, name, user.id, payoutEach);
    } else {
      await deletePayoutsForMembers(parent, myNames);
    }
  } catch (err) {
    console.error('[payout] reaction DB write failed:', err.message);
    return;
  }

  await refreshPayoutState(client, toRef(parent), { canPost: false });
}

// ============================================
// REALTIME SYNC (web ✅ ⇄ discord)
// ============================================

function startPayoutSync(client) {
  const pending = new Map();
  const schedule = (ref) => {
    if (!ref) return;
    const key = ref.recordId || ref.lineupId;
    if (!key) return;
    if (pending.has(key)) clearTimeout(pending.get(key));
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        refreshPayoutState(client, ref, { canPost: false }).catch(err =>
          console.error('[payout] sync update failed:', err.message)
        );
      }, 400)
    );
  };

  supabase
    .channel('lineup-payouts-sync')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'lineup_payouts' },
      (payload) => schedule(refFromLootPayload(payload))
    )
    .subscribe((status) => console.log('[payout] lineup_payouts sync channel:', status));
}

// ============================================
// AUTO-CLOSE SWEEPER
// ============================================

async function sweepDueCloses(client) {
  const nowIso = new Date().toISOString();

  // Due closes can sit on a live lineup OR an archived loot record.
  const [lineupsRes, recordsRes] = await Promise.all([
    supabase
      .from('lineups')
      .select('id, name, loot_thread_id')
      .eq('loot_closed', false)
      .not('loot_close_at', 'is', null)
      .lte('loot_close_at', nowIso)
      .not('loot_thread_id', 'is', null),
    supabase
      .from('loot_records')
      .select('id, lineup_name, loot_thread_id')
      .eq('loot_closed', false)
      .not('loot_close_at', 'is', null)
      .lte('loot_close_at', nowIso)
      .not('loot_thread_id', 'is', null),
  ]);

  if (lineupsRes.error) console.error('[payout] sweep query (lineups) failed:', lineupsRes.error.message);
  if (recordsRes.error) console.error('[payout] sweep query (records) failed:', recordsRes.error.message);

  const due = [
    ...(lineupsRes.data || []).map(l => ({ table: 'lineups', ref: { lineupId: l.id }, id: l.id, name: l.name, lootThreadId: l.loot_thread_id })),
    ...(recordsRes.data || []).map(r => ({ table: 'loot_records', ref: { recordId: r.id }, id: r.id, name: r.lineup_name, lootThreadId: r.loot_thread_id })),
  ];
  if (due.length === 0) return;

  for (const item of due) {
    try {
      // Mark closed first so a slow/failed archive doesn't get retried forever.
      await supabase.from(item.table).update({ loot_closed: true }).eq('id', item.id);
      // Rebuild the message so its footer reads "thread closed" (reads loot_closed=true).
      await refreshPayoutState(client, item.ref, { canPost: false });

      const thread = await client.channels.fetch(item.lootThreadId).catch(() => null);
      if (thread && !thread.archived) {
        await thread.setArchived(true, 'All gold shares confirmed — auto-closing loot thread').catch(err =>
          console.error(`[payout] archive failed for ${item.id}:`, err.message)
        );
      }
      console.log(`[payout] auto-closed loot thread for ${item.name} (${item.table} ${item.id})`);
    } catch (err) {
      console.error(`[payout] sweep failed for ${item.table} ${item.id}:`, err.message);
    }
  }
}

function startLootCloseSweeper(client) {
  console.log(`[payout] starting auto-close sweeper (every ${SWEEP_INTERVAL_MS / 1000}s)`);
  sweepDueCloses(client).catch(err => console.error('[payout] initial sweep failed:', err.message));
  return setInterval(() => {
    sweepDueCloses(client).catch(err => console.error('[payout] scheduled sweep failed:', err.message));
  }, SWEEP_INTERVAL_MS);
}

module.exports = {
  PAYOUT_EMOJI,
  refreshPayoutState,
  onLootChanged,
  handlePayoutReaction,
  startPayoutSync,
  startLootCloseSweeper,
};

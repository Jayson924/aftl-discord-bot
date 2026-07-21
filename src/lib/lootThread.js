// Loot tracking shared lib.
//
// Each cleared lineup gets a loot thread (created in clearLineup.js). Its
// original message is a combined embed — the roster up top + the running loot
// list — which the bot edits in place so Discord keeps the record. Loot is
// logged with the `/loot` slash command (commands/loot.js) or on the website;
// both write the shared `lineup_loot` table, and a realtime subscription keeps
// the Discord embed and the website in sync (two-way).
//
// lineup_loot columns: id, lineup_id, item, sold (bool), price (bigint),
// sort_order, held_by, source ('web'|'discord'), created_by, created_at.

const { EmbedBuilder } = require('discord.js');
const supabase = require('../supabase');
const { getRaidColor, getLineupSize } = require('./raidTypes');

const fmtGold = (n) => (Number(n) || 0).toLocaleString('en-US');

// Escape Discord markdown so item / holder text renders literally.
function escapeMd(str) {
  return String(str ?? '').replace(/([\\*_~`|>])/g, '\\$1');
}

// Resolve a lineup_players.player_name to its display name, mirroring the web's
// getPartyMemberNames: guests are stored as "[PUB]Name|Role".
function partyDisplayName(rawName) {
  if (!rawName) return '';
  if (rawName.startsWith('[PUB]')) {
    const parts = rawName.substring(5).split('|');
    return parts[0] || parts[1] || 'Guest';
  }
  return rawName;
}

// ============================================
// LOOT PARENT ABSTRACTION  (live lineup OR archived loot record)
// ============================================
// After a lineup is archived (see the web app's loot-records.sql), its loot +
// payout rows are re-parented onto a `loot_records` row (record_id set, lineup_id
// nulled) and the lineup is deleted — but the Discord loot thread lives on, its
// ids carried onto the record. So loot/payout logic must work against EITHER
// parent. A "parent" normalizes both into one shape:
//   { kind:'lineup'|'record', id, name, raidType, threadId, lootThreadId,
//     lootMessageId, payoutMessageId, lootCloseAt, lootClosed, rosterSnapshot }
// `threadId` (raid thread) + live roster are lineup-only; records carry a frozen
// `rosterSnapshot` (resolved member names) instead.

const LINEUP_COLS = 'id, name, raid_type, thread_id, loot_thread_id, loot_message_id, payout_message_id, loot_close_at, loot_closed';
const RECORD_COLS = 'id, lineup_name, raid_type, roster, loot_thread_id, loot_message_id, payout_message_id, loot_close_at, loot_closed';

function normalizeLineup(row) {
  if (!row) return null;
  return {
    kind: 'lineup',
    id: row.id,
    name: row.name,
    raidType: row.raid_type,
    threadId: row.thread_id || null,
    lootThreadId: row.loot_thread_id || null,
    lootMessageId: row.loot_message_id || null,
    payoutMessageId: row.payout_message_id || null,
    lootCloseAt: row.loot_close_at || null,
    lootClosed: row.loot_closed === true,
    rosterSnapshot: null,
  };
}

function normalizeRecord(row) {
  if (!row) return null;
  return {
    kind: 'record',
    id: row.id,
    name: row.lineup_name,
    raidType: row.raid_type,
    threadId: null,
    lootThreadId: row.loot_thread_id || null,
    lootMessageId: row.loot_message_id || null,
    payoutMessageId: row.payout_message_id || null,
    lootCloseAt: row.loot_close_at || null,
    lootClosed: row.loot_closed === true,
    rosterSnapshot: Array.isArray(row.roster) ? row.roster.filter(Boolean) : [],
  };
}

// Which loot/payout column parents this kind, e.g. 'lineup_id' vs 'record_id'.
const parentCol = (parent) => (parent.kind === 'record' ? 'record_id' : 'lineup_id');

// Turn a loose arg into a { lineupId } / { recordId } ref.
function toRef(parentOrId) {
  if (parentOrId && typeof parentOrId === 'object' && parentOrId.kind) {
    return parentOrId.kind === 'record' ? { recordId: parentOrId.id } : { lineupId: parentOrId.id };
  }
  return { lineupId: parentOrId }; // legacy: a bare lineup id
}

// Coerce a loose arg into a parent WITHOUT a DB round-trip: full parent passes
// through; a legacy (lineupId, raidType) makes a lite lineup parent. Used by the
// read helpers whose callers already hold the parent (or a live lineup id).
function asParent(parentOrId, raidType) {
  if (parentOrId && typeof parentOrId === 'object' && parentOrId.kind) return parentOrId;
  return { kind: 'lineup', id: parentOrId, raidType, rosterSnapshot: null };
}

// Fetch a fresh, full parent by ref (used where up-to-date bookkeeping matters).
async function resolveParentById({ lineupId, recordId } = {}) {
  if (lineupId) {
    const { data, error } = await supabase.from('lineups').select(LINEUP_COLS).eq('id', lineupId).maybeSingle();
    if (error) { console.error('[loot] resolveParentById(lineup) failed:', error.message); return null; }
    return normalizeLineup(data);
  }
  if (recordId) {
    const { data, error } = await supabase.from('loot_records').select(RECORD_COLS).eq('id', recordId).maybeSingle();
    if (error) { console.error('[loot] resolveParentById(record) failed:', error.message); return null; }
    return normalizeRecord(data);
  }
  return null;
}

// Resolve by Discord thread — matches a live lineup's loot/raid thread first,
// then a loot record's thread. Lets `/loot` work in archived loot threads too.
async function resolveParentByThread(threadId) {
  if (!threadId) return null;
  const { data: lineup } = await supabase
    .from('lineups').select(LINEUP_COLS)
    .or(`loot_thread_id.eq.${threadId},thread_id.eq.${threadId}`)
    .limit(1).maybeSingle();
  if (lineup) return normalizeLineup(lineup);
  const { data: record } = await supabase
    .from('loot_records').select(RECORD_COLS)
    .eq('loot_thread_id', threadId).limit(1).maybeSingle();
  return normalizeRecord(record);
}

// Resolve by the payout confirm message's id (live lineup first, then record).
async function resolveParentByPayoutMessage(messageId) {
  if (!messageId) return null;
  const { data: lineup } = await supabase
    .from('lineups').select(LINEUP_COLS).eq('payout_message_id', messageId).maybeSingle();
  if (lineup) return normalizeLineup(lineup);
  const { data: record } = await supabase
    .from('loot_records').select(RECORD_COLS).eq('payout_message_id', messageId).maybeSingle();
  return normalizeRecord(record);
}

// A loot/payout realtime row carries exactly one of lineup_id / record_id.
function refFromLootPayload(payload) {
  const row = payload.new || payload.old || {};
  if (row.record_id) return { recordId: row.record_id };
  if (row.lineup_id) return { lineupId: row.lineup_id };
  return null;
}

// Update a parent's loot-thread bookkeeping (payout_message_id, close window…) on
// whichever table backs it.
async function updateParentBookkeeping(parent, patch) {
  const table = parent.kind === 'record' ? 'loot_records' : 'lineups';
  const { error } = await supabase.from(table).update(patch).eq('id', parent.id);
  if (error) console.error('[loot] bookkeeping update failed:', error.message);
}

// ============================================
// DATA HELPERS
// ============================================

// Back-compat aliases (live-lineup callers): resolve a parent by thread / id.
const getLineupByThread = resolveParentByThread;
async function getLineupForLoot(lineupId) {
  return resolveParentById({ lineupId });
}

// Attach owner discord ids to display rows. `lookupName` is what we match against
// players.name (raw player_name for lineups, resolved name for records — they're
// equal for real characters; guests match nothing, so stay unlinked).
async function attachDiscordIds(displayRows) {
  const lookup = [...new Set(displayRows.map(r => r.lookupName).filter(Boolean))];
  const map = {};
  if (lookup.length > 0) {
    const { data: players } = await supabase.from('players').select('name, discord_id').in('name', lookup);
    for (const p of players || []) if (p.discord_id) map[p.name] = p.discord_id;
  }
  return displayRows.map(r => ({ name: r.name, discordId: map[r.lookupName] || null }));
}

// Ordered roster for the embed: display name + owner discord id (for clickable,
// non-pinging mentions), in slot order. Accepts a parent, a full parent object,
// or a legacy (lineupId, raidType). Records use their frozen roster snapshot.
async function getRosterDisplay(parentOrId, raidType) {
  const parent = asParent(parentOrId, raidType);

  if (parent.kind === 'record') {
    const names = Array.isArray(parent.rosterSnapshot) ? parent.rosterSnapshot.filter(Boolean) : [];
    return attachDiscordIds(names.map(n => ({ name: n, lookupName: n })));
  }

  const { data: lineupPlayers } = await supabase
    .from('lineup_players')
    .select('player_name, slot_position')
    .eq('lineup_id', parent.id)
    .order('slot_position');
  const size = getLineupSize(parent.raidType);
  const rows = (lineupPlayers || []).slice(0, size).filter(lp => lp.player_name);
  return attachDiscordIds(rows.map(lp => ({
    name: partyDisplayName(lp.player_name),
    lookupName: lp.player_name,
  })));
}

// Just the ordered display names (for autocomplete / grouping).
async function getRoster(parentOrId, raidType) {
  return (await getRosterDisplay(parentOrId, raidType)).map(r => r.name);
}

async function getLootRows(parentOrId) {
  const parent = asParent(parentOrId);
  const { data, error } = await supabase
    .from('lineup_loot')
    .select('id, item, sold, price, sort_order, held_by, source')
    .eq(parentCol(parent), parent.id)
    .order('sort_order');
  if (error) {
    console.error('[loot] getLootRows failed:', error.message);
    return [];
  }
  return (data || []).map(l => ({
    id: l.id,
    item: l.item,
    sold: l.sold === true,
    price: Number(l.price) || 0,
    sortOrder: l.sort_order ?? 0,
    heldBy: l.held_by || '',
    source: l.source || 'web',
  }));
}

async function insertLootEntry(parentOrId, { item, sold = false, price = 0, heldBy = '', createdBy = null }) {
  const parent = asParent(parentOrId);
  const col = parentCol(parent);
  const { data: existing } = await supabase
    .from('lineup_loot')
    .select('sort_order')
    .eq(col, parent.id)
    .order('sort_order', { ascending: false })
    .limit(1);
  const nextOrder = (existing?.[0]?.sort_order ?? -1) + 1;

  const row = {
    item: item.trim(),
    sold: !!sold,
    price: sold ? Math.max(0, Math.round(Number(price) || 0)) : 0,
    sort_order: nextOrder,
    held_by: (heldBy || '').trim() || null,
    source: 'discord',
    created_by: createdBy || null,
  };
  row[col] = parent.id;

  const { data, error } = await supabase
    .from('lineup_loot')
    .insert(row)
    .select('id')
    .single();
  if (error) throw error;
  return data;
}

async function updateLootEntry(lootId, updates) {
  const patch = {};
  if (updates.item !== undefined) patch.item = updates.item.trim();
  if (updates.sold !== undefined) {
    patch.sold = !!updates.sold;
    if (!updates.sold && updates.price === undefined) patch.price = 0;
  }
  if (updates.price !== undefined) patch.price = Math.max(0, Math.round(Number(updates.price) || 0));
  if (updates.heldBy !== undefined) patch.held_by = (updates.heldBy || '').trim() || null;

  const { error } = await supabase.from('lineup_loot').update(patch).eq('id', lootId);
  if (error) throw error;
}

async function deleteLootEntry(lootId) {
  const { error } = await supabase.from('lineup_loot').delete().eq('id', lootId);
  if (error) throw error;
}

// ============================================
// EMBED
// ============================================

// Group loot by holder: party members in roster order → other named holders
// (alpha) → Unassigned last. Mirrors the web's groupLootByHolder.
function groupLootByHolder(lootRows, roster) {
  const byHolder = new Map();
  for (const l of lootRows) {
    const key = l.heldBy || '';
    if (!byHolder.has(key)) byHolder.set(key, []);
    byHolder.get(key).push(l);
  }

  const groups = [];
  for (const name of roster) {
    if (byHolder.has(name)) {
      groups.push({ holder: name, inParty: true, items: byHolder.get(name) });
      byHolder.delete(name);
    }
  }
  [...byHolder.keys()]
    .filter(k => k !== '')
    .sort((a, b) => a.localeCompare(b))
    .forEach(name => {
      groups.push({ holder: name, inParty: false, items: byHolder.get(name) });
      byHolder.delete(name);
    });
  if (byHolder.has('')) groups.push({ holder: '', inParty: false, items: byHolder.get('') });

  return groups.map(g => ({
    ...g,
    total: g.items.reduce((s, l) => s + (l.sold ? l.price : 0), 0),
  }));
}

// The loot thread's original message: roster (with owner mentions) on top, then
// the running loot grouped by holder, plus totals + a raid-thread link. Edited in
// place as loot is logged. `rosterDisplay` = [{ name, discordId }] in slot order.
function buildLootEmbed(lineup, lootRows, rosterDisplay, { raidThreadId } = {}) {
  const rosterNames = rosterDisplay.map(r => r.name);
  const partySize = rosterNames.length;
  const total = lootRows.reduce((s, l) => s + (l.sold ? l.price : 0), 0);
  const payout = partySize > 0 ? Math.floor(total / partySize) : 0;

  // Roster section (the original content). Mentions render as clickable names in
  // an embed — they never ping.
  const rosterSection = rosterDisplay.length
    ? rosterDisplay
        .map((r, i) => {
          const who = r.discordId ? `**${escapeMd(r.name)}** — <@${r.discordId}>` : `**${escapeMd(r.name)}**`;
          return `\`${i + 1}.\` ${who}`;
        })
        .join('\n')
    : '_no players_';

  // Loot section
  let lootSection;
  if (lootRows.length === 0) {
    lootSection = '_No loot logged yet._ · `/loot add` to log an item';
  } else {
    lootSection = groupLootByHolder(lootRows, rosterNames)
      .map(g => {
        const head = g.holder
          ? `⚖️ **${escapeMd(g.holder)}**${g.inParty ? '' : ' _(not in party)_'}`
          : '⚖️ _Unassigned_';
        const sub = g.total > 0 ? `  ·  🪙 ${fmtGold(g.total)}` : '';
        const items = g.items
          .map(l => ` ${l.sold ? `🪙 ${fmtGold(l.price)}` : '`not yet sold`'} — ${escapeMd(l.item)}`)
          .join('\n');
        return `${head}${sub}\n${items}`;
      })
      .join('\n\n');
  }

  let description = `${rosterSection}\n\n**Loot**\n${lootSection}`;
  if (description.length > 4000) description = description.slice(0, 3990) + '\n…';

  const embed = new EmbedBuilder()
    .setTitle(`${lineup.name} — Loot`)
    .setDescription(description)
    .setColor(getRaidColor(lineup.raid_type));

  const fields = [];
  if (total > 0) {
    fields.push(
      { name: 'Total sold', value: `🪙 ${fmtGold(total)}`, inline: true },
      { name: 'Payout each', value: partySize > 0 ? `🪙 ${fmtGold(payout)}  _(÷${partySize})_` : '—', inline: true },
    );
  }
  if (raidThreadId) fields.push({ name: 'Raid thread', value: `<#${raidThreadId}>`, inline: true });
  if (fields.length) embed.addFields(...fields);

  embed.setFooter({ text: `${lootRows.length} loot item${lootRows.length === 1 ? '' : 's'}` });
  return embed;
}

// ============================================
// THREAD MESSAGE
// ============================================

// Rebuild + edit the loot thread's original (roster + loot) message from DB state.
// Accepts a parent object, a legacy lineup id, or a { recordId } ref — always
// re-resolves fresh so bookkeeping (thread/message ids) is current.
async function updateLootMessage(client, parentOrId) {
  const parent = await resolveParentById(toRef(parentOrId));
  if (!parent || !parent.lootThreadId || !parent.lootMessageId) return;

  const [lootRows, rosterDisplay] = await Promise.all([
    getLootRows(parent),
    getRosterDisplay(parent),
  ]);

  const thread = await client.channels.fetch(parent.lootThreadId).catch(() => null);
  if (!thread) return;
  const message = await thread.messages.fetch(parent.lootMessageId).catch(() => null);
  if (!message) return;

  const embedLineup = { name: parent.name, raid_type: parent.raidType };
  await message
    .edit({ embeds: [buildLootEmbed(embedLineup, lootRows, rosterDisplay, { raidThreadId: parent.threadId })] })
    .catch(err => console.error('[loot] message edit failed:', err.message));
}

// ============================================
// REALTIME SYNC (web ⇄ discord)
// ============================================

function startLootSync(client) {
  // Coalesce bursts of changes to the same parent into one embed edit. Keyed by
  // the parent's loot/payout column value (lineup id or record id).
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
        updateLootMessage(client, ref)
          .catch(err => console.error('[loot] sync update failed:', err.message))
          .finally(() => {
            // Once loot changes settle, (re)build the payout confirm message.
            // Lazy require avoids a circular dependency (lootPayout needs lootThread).
            try {
              require('./lootPayout').onLootChanged(client, ref);
            } catch (err) {
              console.error('[loot] payout hook failed:', err.message);
            }
          });
      }, 400)
    );
  };

  supabase
    .channel('lineup-loot-sync')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'lineup_loot' },
      (payload) => schedule(refFromLootPayload(payload))
    )
    .subscribe((status) => console.log('[loot] lineup_loot sync channel:', status));
}

module.exports = {
  fmtGold,
  partyDisplayName,
  // parent abstraction (lineup ⇄ loot record)
  resolveParentById,
  resolveParentByThread,
  resolveParentByPayoutMessage,
  refFromLootPayload,
  updateParentBookkeeping,
  parentCol,
  toRef,
  // back-compat aliases
  getLineupByThread,
  getLineupForLoot,
  getRosterDisplay,
  getRoster,
  getLootRows,
  insertLootEntry,
  updateLootEntry,
  deleteLootEntry,
  groupLootByHolder,
  buildLootEmbed,
  updateLootMessage,
  startLootSync,
};

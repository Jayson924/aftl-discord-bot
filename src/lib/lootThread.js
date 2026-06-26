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
// DATA HELPERS
// ============================================

// Find the lineup for a Discord thread — matches either the loot thread or the
// raid thread, so `/loot` works in either.
async function getLineupByThread(threadId) {
  if (!threadId) return null;
  const { data, error } = await supabase
    .from('lineups')
    .select('id, name, raid_type, loot_thread_id, loot_message_id, thread_id')
    .or(`loot_thread_id.eq.${threadId},thread_id.eq.${threadId}`)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[loot] getLineupByThread failed:', error.message);
    return null;
  }
  return data;
}

async function getLineupForLoot(lineupId) {
  const { data, error } = await supabase
    .from('lineups')
    .select('id, name, raid_type, thread_id, loot_thread_id, loot_message_id')
    .eq('id', lineupId)
    .maybeSingle();
  if (error) {
    console.error('[loot] getLineupForLoot failed:', error.message);
    return null;
  }
  return data;
}

// Ordered roster for the embed: display name + owner discord id (for clickable,
// non-pinging mentions), in slot order. Used for the roster section, the payout
// count, and holder grouping order.
async function getRosterDisplay(lineupId, raidType) {
  const { data: lineupPlayers } = await supabase
    .from('lineup_players')
    .select('player_name, slot_position')
    .eq('lineup_id', lineupId)
    .order('slot_position');
  const size = getLineupSize(raidType);
  const rows = (lineupPlayers || []).slice(0, size).filter(lp => lp.player_name);

  const names = rows.map(lp => lp.player_name);
  const discordMap = {};
  if (names.length > 0) {
    const { data: players } = await supabase.from('players').select('name, discord_id').in('name', names);
    for (const p of players || []) if (p.discord_id) discordMap[p.name] = p.discord_id;
  }

  return rows.map(lp => ({
    name: partyDisplayName(lp.player_name),
    discordId: discordMap[lp.player_name] || null,
  }));
}

// Just the ordered display names (for autocomplete / grouping).
async function getRoster(lineupId, raidType) {
  return (await getRosterDisplay(lineupId, raidType)).map(r => r.name);
}

async function getLootRows(lineupId) {
  const { data, error } = await supabase
    .from('lineup_loot')
    .select('id, item, sold, price, sort_order, held_by, source')
    .eq('lineup_id', lineupId)
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

async function insertLootEntry(lineupId, { item, sold = false, price = 0, heldBy = '', createdBy = null }) {
  const { data: existing } = await supabase
    .from('lineup_loot')
    .select('sort_order')
    .eq('lineup_id', lineupId)
    .order('sort_order', { ascending: false })
    .limit(1);
  const nextOrder = (existing?.[0]?.sort_order ?? -1) + 1;

  const { data, error } = await supabase
    .from('lineup_loot')
    .insert({
      lineup_id: lineupId,
      item: item.trim(),
      sold: !!sold,
      price: sold ? Math.max(0, Math.round(Number(price) || 0)) : 0,
      sort_order: nextOrder,
      held_by: (heldBy || '').trim() || null,
      source: 'discord',
      created_by: createdBy || null,
    })
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
async function updateLootMessage(client, lineupId) {
  const lineup = await getLineupForLoot(lineupId);
  if (!lineup || !lineup.loot_thread_id || !lineup.loot_message_id) return;

  const [lootRows, rosterDisplay] = await Promise.all([
    getLootRows(lineupId),
    getRosterDisplay(lineupId, lineup.raid_type),
  ]);

  const thread = await client.channels.fetch(lineup.loot_thread_id).catch(() => null);
  if (!thread) return;
  const message = await thread.messages.fetch(lineup.loot_message_id).catch(() => null);
  if (!message) return;

  await message
    .edit({ embeds: [buildLootEmbed(lineup, lootRows, rosterDisplay, { raidThreadId: lineup.thread_id })] })
    .catch(err => console.error('[loot] message edit failed:', err.message));
}

// ============================================
// REALTIME SYNC (web ⇄ discord)
// ============================================

function startLootSync(client) {
  // Coalesce bursts of changes to the same lineup into one embed edit.
  const pending = new Map();
  const schedule = (lineupId) => {
    if (!lineupId) return;
    if (pending.has(lineupId)) clearTimeout(pending.get(lineupId));
    pending.set(
      lineupId,
      setTimeout(() => {
        pending.delete(lineupId);
        updateLootMessage(client, lineupId).catch(err =>
          console.error('[loot] sync update failed:', err.message)
        );
      }, 400)
    );
  };

  supabase
    .channel('lineup-loot-sync')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'lineup_loot' },
      (payload) => {
        const lineupId = payload.new?.lineup_id || payload.old?.lineup_id;
        schedule(lineupId);
      }
    )
    .subscribe((status) => console.log('[loot] lineup_loot sync channel:', status));
}

module.exports = {
  fmtGold,
  partyDisplayName,
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

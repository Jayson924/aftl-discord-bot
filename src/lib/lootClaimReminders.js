// Daily "you've still got gold to claim" reminders.
//
// Twice a day (default 09:00 and 21:00, GMT+8 — the guild's timezone) the bot
// sweeps every OPEN loot thread (a live lineup OR an archived record with a
// posted payout message that hasn't closed) and pings the linked members who
// haven't fully claimed their share yet. The tag goes to the responsible person
// per slot (pilot-first, same as the payout message), deduped so a user with
// several unclaimed characters is pinged once per thread.
//
// Config (env):
//   CLAIM_REMINDER_HOURS       comma list of hours to fire at (default "9,21")
//   CLAIM_REMINDER_UTC_OFFSET  timezone offset in hours for those (default 8)
//   CLAIM_REMINDERS_ENABLED    "false" to disable entirely (default on)

const supabase = require('../supabase');
const { resolveParentById, getRosterDisplay, getLootRows, fmtGold } = require('./lootThread');
const { PAYOUT_EMOJI, CLAIM_REMINDER_MARKER } = require('./lootPayout');

const CHECK_INTERVAL_MS = 60 * 1000; // 1-minute tick, like the raid reminder loop

const REMINDER_HOURS = (process.env.CLAIM_REMINDER_HOURS || '9,21')
  .split(',')
  .map(h => parseInt(h.trim(), 10))
  .filter(h => Number.isInteger(h) && h >= 0 && h <= 23);

const UTC_OFFSET_HOURS = Number.isFinite(parseInt(process.env.CLAIM_REMINDER_UTC_OFFSET, 10))
  ? parseInt(process.env.CLAIM_REMINDER_UTC_OFFSET, 10)
  : 8;

const ENABLED = process.env.CLAIM_REMINDERS_ENABLED !== 'false';

// Which target slots we've already fired for (keyed YYYY-MM-DD-HH in the target
// tz). In-memory: a restart within a slot's hour may re-ping once — acceptable
// for a low-stakes reminder. Pruned to the current day so it can't grow.
const firedSlots = new Set();
let firedSlotsDay = '';

// Current wall-clock in the configured GMT offset (no DST — matches the app's
// GMT+8 convention). Returns { dayKey, hour }.
function nowInTargetTz() {
  const shifted = new Date(Date.now() + UTC_OFFSET_HOURS * 3600 * 1000);
  const dayKey = `${shifted.getUTCFullYear()}-${shifted.getUTCMonth() + 1}-${shifted.getUTCDate()}`;
  return { dayKey, hour: shifted.getUTCHours() };
}

async function getPayoutAmounts(parent) {
  const col = parent.kind === 'record' ? 'record_id' : 'lineup_id';
  const { data, error } = await supabase
    .from('lineup_payouts')
    .select('member_name, amount')
    .eq(col, parent.id);
  if (error) {
    console.error('[ClaimReminders] payout fetch failed:', error.message);
    return new Map();
  }
  return new Map((data || []).map(p => [p.member_name, Number(p.amount) || 0]));
}

// Ping the still-unclaimed linked members for one open loot thread.
async function remindEntry(client, ref, name) {
  const parent = await resolveParentById(ref);
  if (!parent || !parent.lootThreadId || parent.lootClosed) return;

  const [lootRows, rosterDisplay, paidMap] = await Promise.all([
    getLootRows(parent),
    getRosterDisplay(parent),
    getPayoutAmounts(parent),
  ]);

  const partySize = rosterDisplay.length;
  const total = lootRows.reduce((s, l) => s + (l.sold ? l.price : 0), 0);
  const payoutEach = partySize > 0 ? Math.floor(total / partySize) : 0;
  if (payoutEach <= 0) return; // nothing sold to claim yet

  // Linked members (pilot-first responsible id) who haven't withdrawn their share.
  const owedIds = new Set();
  for (const m of rosterDisplay) {
    if (!m.discordId) continue; // guests are auto-covered
    if ((paidMap.get(m.name) || 0) < payoutEach) owedIds.add(m.discordId);
  }
  if (owedIds.size === 0) return;

  const thread = await client.channels.fetch(parent.lootThreadId).catch(() => null);
  if (!thread) return;

  const ids = [...owedIds];
  const mentions = ids.map(id => `<@${id}>`).join(' ');
  // Content MUST include CLAIM_REMINDER_MARKER — the reaction handler keys on it
  // to accept a ✅ right here instead of only on the payout message.
  const msg = await thread
    .send({
      content:
        `⏰ **${CLAIM_REMINDER_MARKER}** — 🪙 ${fmtGold(payoutEach)} each for **${name}**.\n` +
        `${mentions} — react ${PAYOUT_EMOJI} right here (or on the payout message) once you've grabbed your share.`,
      allowedMentions: { users: ids },
    })
    .catch(err => { console.error(`[ClaimReminders] send failed for ${parent.kind} ${parent.id}:`, err.message); return null; });

  // Seed the ✅ so members can just click it on the reminder itself.
  if (msg) await msg.react(PAYOUT_EMOJI).catch(() => {});
}

async function sweep(client) {
  // Open loot threads = a posted payout message that hasn't closed yet, on a live
  // lineup or an archived record.
  const [lineupsRes, recordsRes] = await Promise.all([
    supabase.from('lineups')
      .select('id, name, loot_thread_id')
      .eq('loot_closed', false)
      .not('loot_thread_id', 'is', null)
      .not('payout_message_id', 'is', null),
    supabase.from('loot_records')
      .select('id, lineup_name, loot_thread_id')
      .eq('loot_closed', false)
      .not('loot_thread_id', 'is', null)
      .not('payout_message_id', 'is', null),
  ]);

  if (lineupsRes.error) console.error('[ClaimReminders] lineups query failed:', lineupsRes.error.message);
  if (recordsRes.error) console.error('[ClaimReminders] records query failed:', recordsRes.error.message);

  const entries = [
    ...(lineupsRes.data || []).map(l => ({ ref: { lineupId: l.id }, name: l.name })),
    ...(recordsRes.data || []).map(r => ({ ref: { recordId: r.id }, name: r.lineup_name })),
  ];
  if (entries.length === 0) return;

  console.log(`[ClaimReminders] sweeping ${entries.length} open loot thread(s)`);
  for (const e of entries) {
    await remindEntry(client, e.ref, e.name).catch(err =>
      console.error('[ClaimReminders] entry failed:', err.message));
  }
}

function tick(client) {
  const { dayKey, hour } = nowInTargetTz();

  // Reset the fired-slot memory at day rollover so it can't grow unbounded.
  if (dayKey !== firedSlotsDay) {
    firedSlots.clear();
    firedSlotsDay = dayKey;
  }

  if (!REMINDER_HOURS.includes(hour)) return;
  const slotKey = `${dayKey}-${hour}`;
  if (firedSlots.has(slotKey)) return;
  firedSlots.add(slotKey);

  console.log(`[ClaimReminders] firing slot ${slotKey} (GMT+${UTC_OFFSET_HOURS})`);
  sweep(client).catch(err => console.error('[ClaimReminders] sweep failed:', err.message));
}

function startLootClaimReminders(client) {
  if (!ENABLED) {
    console.log('[ClaimReminders] disabled via CLAIM_REMINDERS_ENABLED=false');
    return null;
  }
  if (REMINDER_HOURS.length === 0) {
    console.log('[ClaimReminders] no valid CLAIM_REMINDER_HOURS — not starting');
    return null;
  }
  console.log(`[ClaimReminders] starting — hours [${REMINDER_HOURS.join(', ')}] at GMT+${UTC_OFFSET_HOURS}`);
  // If the bot boots DURING a target hour, treat that slot as already handled so
  // a restart mid-slot doesn't re-ping (the next slot fires normally). The small
  // trade-off: a fresh boot mid-slot skips that one occurrence.
  const { dayKey, hour } = nowInTargetTz();
  firedSlotsDay = dayKey;
  if (REMINDER_HOURS.includes(hour)) firedSlots.add(`${dayKey}-${hour}`);
  return setInterval(() => tick(client), CHECK_INTERVAL_MS);
}

module.exports = { startLootClaimReminders };

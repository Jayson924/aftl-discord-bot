// Centralized raid-type metadata. Mirrors src/constants.js + src/data.js on
// the web app — keep these in sync when raid types change.

const FOUR_MAN_TYPES = new Set(['4-man', 'DDN Normal']);

// Map raid_type → players-table column tracking weekly completion. Returns
// null for raid types that don't track weekly completion (4-man, Unspecified).
function getCompletionColumn(raidType) {
  if (raidType === 'DDN Hardcore') return 'ddn_hardcore_completed';
  if (raidType === 'DDN Classic') return 'ddn_classic_completed';
  if (raidType === 'DDN Normal') return 'ddn_normal_completed';
  if (raidType === 'BDN Classic') return 'bdn_classic_completed';
  return null;
}

// All weekly-completion columns the bot reads off players rows.
const ALL_COMPLETION_COLUMNS = [
  'ddn_hardcore_completed',
  'ddn_classic_completed',
  'ddn_normal_completed',
  'bdn_classic_completed',
];

function isFourManRaid(raidType) {
  return FOUR_MAN_TYPES.has(raidType);
}

function getLineupSize(raidType) {
  return isFourManRaid(raidType) ? 4 : 8;
}

// Embed accent color per raid type. Sand tones for DDN, dusk purple for BDN.
function getRaidColor(raidType) {
  switch (raidType) {
    case 'DDN Hardcore': return 0xa06430; // DDN — dark sand
    case 'DDN Classic':  return 0xc69257; // DDN — sand
    case 'DDN Normal':   return 0xd9b07c; // DDN — pale dune
    case 'BDN Classic':  return 0x5b3a8c; // BDN — dusk
    case '4-man':        return 0x7f8c8d; // neutral grey
    default:             return 0x3498db;
  }
}

// Every "<X> Classic" raid allows one extra Pania ticket clear per week.
function usesTickets(raidType) {
  return / Classic$/.test(raidType || '');
}

// Forum tag name per raid type. Used only as a fallback when no tag ID env var
// is configured. The actual tags have emoji in their display, so prefer the ID
// map below — name matching is fragile if the emoji ends up in the name text.
// Returns null for raid types with no dedicated tag (4-man, Unspecified, DDN Normal).
function getRaidTagName(raidType) {
  switch (raidType) {
    case 'DDN Hardcore': return 'DDN HC';
    case 'DDN Classic':  return 'DDN C';
    case 'BDN Classic':  return 'BDN C';
    default:             return null;
  }
}

// raid_type → forum tag ID. Tag IDs are exact and immune to renames/emoji, so
// they win over name matching. Hardcoded for now; the matching RAID_TAG_* env
// var overrides if set.
const RAID_TAG_IDS = {
  'DDN Hardcore': '1508047897235816448', // DDN HC
  'DDN Classic': '1508047435992272907',  // DDN C
  // 'BDN Classic': create the BDN C forum tag in Discord, then add its ID here
  // (or set RAID_TAG_BDN_C). Until then tagging falls back to name match.
};

const RAID_TAG_ENV_MAP = {
  'DDN Hardcore': 'RAID_TAG_DDN_HC',
  'DDN Classic': 'RAID_TAG_DDN_C',
  'BDN Classic': 'RAID_TAG_BDN_C',
};

function getRaidTagId(raidType) {
  const envVar = RAID_TAG_ENV_MAP[raidType];
  if (envVar && process.env[envVar]) return process.env[envVar];
  return RAID_TAG_IDS[raidType] || null;
}

// Resolve the forum tag object for a raid type from a forum channel's available
// tags. Prefers the configured tag ID, then falls back to name match. Returns
// null if nothing matches (tagging is then skipped).
function resolveRaidTag(raidType, availableTags = []) {
  const tagId = getRaidTagId(raidType);
  if (tagId) {
    const byId = availableTags.find(t => t.id === tagId);
    if (byId) return byId;
  }
  const tagName = getRaidTagName(raidType);
  if (tagName) {
    const byName = availableTags.find(t => t.name.toLowerCase() === tagName.toLowerCase());
    if (byName) return byName;
  }
  return null;
}

// Game map ids per raid type, mirroring GAME_RAIDS in the site's src/raid-clears.js.
const GAME_RAID_STAGES = {
  'BDN Classic': { stages: [14501] },
  'DDN Hardcore': { stages: [17610] },
  'DDN Classic': { stages: [14221] },
  'DDN Normal': { stages: [14210, 14211, 14212, 14213], allStages: true },
};

// Columns that carry the game's synced weekly clears (see the site's add-weekly-clears*.sql).
const WEEKLY_CLEARS_COLUMNS = ['weekly_clears', 'weekly_clears_at'];

const SEA_OFFSET_MS = 8 * 3600e3;
const RESET_HOUR_MS = 9 * 3600e3;

// The game's week turns at Saturday 09:00 SEA time (UTC+8), which is Saturday 01:00 UTC.
function gameWeekStart(now = new Date()) {
  const sea = new Date(now.getTime() + SEA_OFFSET_MS - RESET_HOUR_MS);
  const daysSinceSaturday = (sea.getUTCDay() + 1) % 7;
  return new Date(Date.UTC(sea.getUTCFullYear(), sea.getUTCMonth(), sea.getUTCDate() - daysSinceSaturday) - SEA_OFFSET_MS + RESET_HOUR_MS);
}

function isThisGameWeek(timestamp, now = new Date()) {
  if (!timestamp) return false;
  const time = new Date(timestamp).getTime();
  return Number.isFinite(time) && time >= gameWeekStart(now).getTime();
}

// Whether the game's synced counts from this week show the raid cleared.
function isGameCleared(character, raidType, now = new Date()) {
  const raid = GAME_RAID_STAGES[raidType];
  const weeklyClears = character.weekly_clears;
  if (!raid || !weeklyClears || !isThisGameWeek(character.weekly_clears_at, now)) return false;
  const cleared = raid.stages.map((id) => (Number(weeklyClears[id]?.clears) || 0) > 0);
  return raid.allStages ? cleared.every(Boolean) : cleared.some(Boolean);
}

// Whether a character can still clear this raid this week; mirrors the site's raidStatus plus the ticket clear.
function isCharacterEligible(character, raidType, now = new Date()) {
  const column = getCompletionColumn(raidType);
  // 4-man / Unspecified — no completion model wired in, treat as eligible.
  if (!column) return true;
  // Classic raids: 1 base clear + 1 ticket clear per week.
  if (usesTickets(raidType) && !character.tickets_used?.[raidType]) return true;
  if (isGameCleared(character, raidType, now)) return false;
  return !isThisGameWeek(character[column], now);
}

// Slash command choice list. Order matches the web app's selectors.
// DDN Normal / 4-man were retired from the web selectors; the data layer
// keeps mapping them for any legacy lineup rows.
const RAID_TYPE_CHOICES = [
  { name: 'BDN Classic', value: 'BDN Classic' },
  { name: 'DDN Hardcore', value: 'DDN Hardcore' },
  { name: 'DDN Classic', value: 'DDN Classic' },
];

module.exports = {
  ALL_COMPLETION_COLUMNS,
  WEEKLY_CLEARS_COLUMNS,
  gameWeekStart,
  isGameCleared,
  isThisGameWeek,
  RAID_TYPE_CHOICES,
  getCompletionColumn,
  getLineupSize,
  getRaidColor,
  getRaidTagName,
  getRaidTagId,
  resolveRaidTag,
  isCharacterEligible,
  isFourManRaid,
  usesTickets,
};

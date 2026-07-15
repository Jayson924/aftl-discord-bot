// Centralized raid-type metadata. Mirrors src/constants.js + src/data.js on
// the web app — keep these in sync when raid types change.

const FOUR_MAN_TYPES = new Set(['4-man', 'DDN Normal']);

// Map raid_type → players-table column tracking weekly completion. Returns
// null for raid types that don't track weekly completion (4-man, Unspecified).
function getCompletionColumn(raidType) {
  if (raidType === 'Hardcore') return 'hardcore_completed';
  if (raidType === 'Classic') return 'classic_completed';
  if (raidType === 'DDN Hardcore') return 'ddn_hardcore_completed';
  if (raidType === 'DDN Classic') return 'ddn_classic_completed';
  if (raidType === 'DDN Normal') return 'ddn_normal_completed';
  return null;
}

// All weekly-completion columns the bot reads off players rows.
const ALL_COMPLETION_COLUMNS = [
  'hardcore_completed',
  'classic_completed',
  'ddn_hardcore_completed',
  'ddn_classic_completed',
  'ddn_normal_completed',
];

function isFourManRaid(raidType) {
  return FOUR_MAN_TYPES.has(raidType);
}

function getLineupSize(raidType) {
  return isFourManRaid(raidType) ? 4 : 8;
}

// Embed accent color per raid type. Jungle greens for GDN, sand tones for DDN.
function getRaidColor(raidType) {
  switch (raidType) {
    case 'Hardcore':     return 0x2d6a3a; // GDN — deep forest
    case 'Classic':      return 0x5b9c3e; // GDN — leaf
    case 'DDN Hardcore': return 0xa06430; // DDN — dark sand
    case 'DDN Classic':  return 0xc69257; // DDN — sand
    case 'DDN Normal':   return 0xd9b07c; // DDN — pale dune
    case '4-man':        return 0x7f8c8d; // neutral grey
    default:             return 0x3498db;
  }
}

// Whether a raid type uses the ticket system (only GDN Classic does).
function usesTickets(raidType) {
  return raidType === 'Classic';
}

// Forum tag name per raid type. Used only as a fallback when no tag ID env var
// is configured. The actual tags have emoji in their display, so prefer the ID
// map below — name matching is fragile if the emoji ends up in the name text.
// Returns null for raid types with no dedicated tag (4-man, Unspecified, DDN Normal).
function getRaidTagName(raidType) {
  switch (raidType) {
    case 'Hardcore':     return 'GDN HC';
    case 'Classic':      return 'GDN C';
    case 'DDN Hardcore': return 'DDN HC';
    case 'DDN Classic':  return 'DDN C';
    default:             return null;
  }
}

// raid_type → forum tag ID. Tag IDs are exact and immune to renames/emoji, so
// they win over name matching. Hardcoded for now; the matching RAID_TAG_* env
// var overrides if set.
const RAID_TAG_IDS = {
  'Hardcore': '1496955589329158327',     // GDN HC
  'Classic': '1496955552649973985',      // GDN C
  'DDN Hardcore': '1508047897235816448', // DDN HC
  'DDN Classic': '1508047435992272907',  // DDN C
};

const RAID_TAG_ENV_MAP = {
  'Hardcore': 'RAID_TAG_GDN_HC',
  'Classic': 'RAID_TAG_GDN_C',
  'DDN Hardcore': 'RAID_TAG_DDN_HC',
  'DDN Classic': 'RAID_TAG_DDN_C',
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

// Whether a character can still clear this raid this week.
// Mirrors data.js#playerNeedsRaid on the web app. Pass a player row that
// includes the relevant completion columns.
function isCharacterEligible(character, raidType) {
  if (raidType === 'Hardcore') return !character.hardcore_completed;
  if (raidType === 'Classic') {
    // 1 base clear + 1 ticket clear per week — eligible if either is unused.
    return !character.classic_completed || !character.classic_ticket_used;
  }
  if (raidType === 'DDN Hardcore') return !character.ddn_hardcore_completed;
  if (raidType === 'DDN Classic') return !character.ddn_classic_completed;
  if (raidType === 'DDN Normal') return !character.ddn_normal_completed;
  // 4-man / Unspecified — no completion model wired in, treat as eligible.
  return true;
}

// Slash command choice list. Order matches the web app's selectors.
// DDN Normal / 4-man were retired from the web selectors; the data layer
// keeps mapping them for any legacy lineup rows.
const RAID_TYPE_CHOICES = [
  { name: 'DDN Hardcore', value: 'DDN Hardcore' },
  { name: 'DDN Classic', value: 'DDN Classic' },
  { name: 'GDN Hardcore', value: 'Hardcore' },
  { name: 'GDN Classic', value: 'Classic' },
];

module.exports = {
  ALL_COMPLETION_COLUMNS,
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

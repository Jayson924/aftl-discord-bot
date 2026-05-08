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
    case 'DDN Hardcore': return 0xa06430; // DDN — dark sand (unreleased)
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
// DDN Hardcore is omitted from user-facing choices because the raid is
// unreleased — the data layer still supports it for future activation.
const RAID_TYPE_CHOICES = [
  { name: 'GDN Hardcore', value: 'Hardcore' },
  { name: 'GDN Classic', value: 'Classic' },
  { name: 'DDN Classic', value: 'DDN Classic' },
  { name: 'DDN Normal', value: 'DDN Normal' },
  { name: '4-Man', value: '4-man' },
];

module.exports = {
  ALL_COMPLETION_COLUMNS,
  RAID_TYPE_CHOICES,
  getCompletionColumn,
  getLineupSize,
  getRaidColor,
  isCharacterEligible,
  isFourManRaid,
  usesTickets,
};

const supabase = require('../supabase');
const { getClassEmojiTag } = require('./classEmojis');

/**
 * Fetch mention info for all players in a lineup.
 * Groups by discord_id, so a user with multiple characters in the same
 * lineup only gets pinged once but with all their character names listed.
 *
 * When `includePilots` is set, also resolves each slot's pilot (stored as a
 * display-name string) to a Discord ID via app_users and returns them as
 * additional groups flagged `isPilot: true`. Pilots whose name doesn't match a
 * registered user (free-text guests) are skipped, and a pilot that is the same
 * person as the character's owner is skipped to avoid a redundant double-ping.
 *
 * @param {string} lineupId
 * @param {{ includePilots?: boolean }} [opts]
 * @returns {Promise<Array<{ discordId: string, characterNames: string[], characters: Array, isPilot: boolean }>>}
 */
async function getLineupMentions(lineupId, { includePilots = false } = {}) {
  const { data: lineupPlayers, error: lpError } = await supabase
    .from('lineup_players')
    .select('player_name, slot_position, pilot_name')
    .eq('lineup_id', lineupId)
    .order('slot_position');

  if (lpError || !lineupPlayers || lineupPlayers.length === 0) return [];

  const names = lineupPlayers.map(lp => lp.player_name).filter(Boolean);
  if (names.length === 0) return [];

  const { data: players, error: pError } = await supabase
    .from('players')
    .select('name, discord_id, role')
    .in('name', names);

  if (pError || !players) return [];

  // Build name → { discord_id, role } map
  const nameToInfo = new Map();
  for (const p of players) {
    if (p.discord_id) nameToInfo.set(p.name, { discordId: p.discord_id, role: p.role || null });
  }

  // Group owners by discord_id, preserving slot order for character names
  const idToChars = new Map();
  for (const lp of lineupPlayers) {
    const info = nameToInfo.get(lp.player_name);
    if (!info) continue;
    if (!idToChars.has(info.discordId)) idToChars.set(info.discordId, []);
    idToChars.get(info.discordId).push({ name: lp.player_name, role: info.role });
  }

  const ownerGroups = [...idToChars.entries()].map(([discordId, characters]) => ({
    discordId,
    characterNames: characters.map(c => c.name), // legacy field, kept for callers
    characters,
    isPilot: false,
  }));

  if (!includePilots) return ownerGroups;

  const pilotGroups = await getPilotMentions(lineupPlayers, nameToInfo);
  return [...ownerGroups, ...pilotGroups];
}

/**
 * Resolve pilots (stored as display-name strings on lineup_players.pilot_name)
 * to Discord IDs via app_users, grouped by pilot discord_id.
 *
 * @param {Array<{ player_name: string, pilot_name: string|null }>} lineupPlayers
 * @param {Map<string, { discordId: string, role: string|null }>} nameToInfo - character name → owner info
 * @returns {Promise<Array<{ discordId: string, characterNames: string[], characters: Array, isPilot: boolean }>>}
 */
async function getPilotMentions(lineupPlayers, nameToInfo) {
  const hasPilots = lineupPlayers.some(lp => (lp.pilot_name || '').trim());
  if (!hasPilots) return [];

  const nameToId = await getPilotNameToId();

  // Group piloted characters by pilot discord_id
  const idToChars = new Map();
  for (const lp of lineupPlayers) {
    const pilot = (lp.pilot_name || '').trim();
    if (!pilot) continue;

    const pilotId = nameToId.get(pilot.toLowerCase());
    if (!pilotId) continue; // unregistered / free-text pilot → roster text only

    // Skip when the pilot is the same person as the owner (redundant ping)
    const ownerInfo = nameToInfo.get(lp.player_name);
    if (ownerInfo && ownerInfo.discordId === pilotId) continue;

    if (!idToChars.has(pilotId)) idToChars.set(pilotId, []);
    idToChars.get(pilotId).push({ name: lp.player_name, role: ownerInfo?.role || null });
  }

  return [...idToChars.entries()].map(([discordId, characters]) => ({
    discordId,
    characterNames: characters.map(c => c.name),
    characters,
    isPilot: true,
  }));
}

/**
 * Build a lowercased "pilot name → discord_id" lookup from app_users.
 * The web stores the pilot's effective display name (display_name || username),
 * so both forms are mapped (display_name wins on collision).
 *
 * @returns {Promise<Map<string, string>>}
 */
async function getPilotNameToId() {
  const { data: users, error } = await supabase
    .from('app_users')
    .select('discord_id, display_name, username');

  const nameToId = new Map();
  if (error || !users) return nameToId;

  for (const u of users) {
    if (!u.discord_id) continue;
    const dn = (u.display_name || '').trim().toLowerCase();
    const un = (u.username || '').trim().toLowerCase();
    if (dn) nameToId.set(dn, u.discord_id);
    if (un && !nameToId.has(un)) nameToId.set(un, u.discord_id);
  }
  return nameToId;
}

/**
 * Format a mention group as "<@id> (<:Class:id> Char1, <:Class:id> Char2)".
 * Falls back to plain names when no class emoji is configured.
 */
function formatMention({ discordId, characterNames, characters, isPilot }) {
  // Prefer the richer `characters` shape when present (has class info for emoji)
  const list = characters && characters.length > 0
    ? characters
    : (characterNames || []).map(name => ({ name, role: null }));

  const labelled = list.map(({ name, role }) => {
    const emoji = role ? getClassEmojiTag(role) : '';
    return emoji ? `${emoji} ${name}` : name;
  }).join(', ');

  if (!labelled) return `<@${discordId}>`;
  return isPilot
    ? `<@${discordId}> (piloting ${labelled})`
    : `<@${discordId}> (${labelled})`;
}

/**
 * Format a list of mention groups as newline-separated mentions.
 */
function formatMentionList(mentions) {
  return mentions.map(formatMention).join('\n');
}

module.exports = { getLineupMentions, getPilotMentions, getPilotNameToId, formatMention, formatMentionList };

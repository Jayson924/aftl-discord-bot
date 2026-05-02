const supabase = require('../supabase');
const { getClassEmojiTag } = require('./classEmojis');

/**
 * Fetch mention info for all players in a lineup.
 * Groups by discord_id, so a user with multiple characters in the same
 * lineup only gets pinged once but with all their character names listed.
 *
 * @param {string} lineupId
 * @returns {Promise<Array<{ discordId: string, characterNames: string[] }>>}
 */
async function getLineupMentions(lineupId) {
  const { data: lineupPlayers, error: lpError } = await supabase
    .from('lineup_players')
    .select('player_name, slot_position')
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

  // Group by discord_id, preserving slot order for character names
  const idToChars = new Map();
  for (const lp of lineupPlayers) {
    const info = nameToInfo.get(lp.player_name);
    if (!info) continue;
    if (!idToChars.has(info.discordId)) idToChars.set(info.discordId, []);
    idToChars.get(info.discordId).push({ name: lp.player_name, role: info.role });
  }

  return [...idToChars.entries()].map(([discordId, characters]) => ({
    discordId,
    characterNames: characters.map(c => c.name), // legacy field, kept for callers
    characters,
  }));
}

/**
 * Format a mention group as "<@id> (<:Class:id> Char1, <:Class:id> Char2)".
 * Falls back to plain names when no class emoji is configured.
 */
function formatMention({ discordId, characterNames, characters }) {
  // Prefer the richer `characters` shape when present (has class info for emoji)
  const list = characters && characters.length > 0
    ? characters
    : (characterNames || []).map(name => ({ name, role: null }));

  const labelled = list.map(({ name, role }) => {
    const emoji = role ? getClassEmojiTag(role) : '';
    return emoji ? `${emoji} ${name}` : name;
  }).join(', ');

  return labelled ? `<@${discordId}> (${labelled})` : `<@${discordId}>`;
}

/**
 * Format a list of mention groups as newline-separated mentions.
 */
function formatMentionList(mentions) {
  return mentions.map(formatMention).join('\n');
}

module.exports = { getLineupMentions, formatMention, formatMentionList };

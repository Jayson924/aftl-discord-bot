const supabase = require('../supabase');

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
    .select('name, discord_id')
    .in('name', names);

  if (pError || !players) return [];

  // Build name → discord_id map
  const nameToId = new Map();
  for (const p of players) {
    if (p.discord_id) nameToId.set(p.name, p.discord_id);
  }

  // Group by discord_id, preserving slot order for character names
  const idToChars = new Map();
  for (const lp of lineupPlayers) {
    const discordId = nameToId.get(lp.player_name);
    if (!discordId) continue;
    if (!idToChars.has(discordId)) idToChars.set(discordId, []);
    idToChars.get(discordId).push(lp.player_name);
  }

  return [...idToChars.entries()].map(([discordId, characterNames]) => ({
    discordId,
    characterNames,
  }));
}

/**
 * Format a mention group as "<@id> (Char1, Char2)".
 */
function formatMention({ discordId, characterNames }) {
  const chars = characterNames.join(', ');
  return chars ? `<@${discordId}> (${chars})` : `<@${discordId}>`;
}

/**
 * Format a list of mention groups as newline-separated mentions.
 */
function formatMentionList(mentions) {
  return mentions.map(formatMention).join('\n');
}

module.exports = { getLineupMentions, formatMention, formatMentionList };

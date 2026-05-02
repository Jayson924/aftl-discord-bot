/**
 * Detect same-account conflicts in a lineup roster.
 * Mirrors getAccountConflicts() in aftl-raid/src/pages/lineup-editor.jsx so
 * the bot enforces the same rule the editor warns about.
 *
 * @param {Array<{player_name: string}>} lineupPlayers - rows from lineup_players
 * @param {Array<{name: string, discord_id: string|null, account_number: number|null}>} players - rows from players
 * @returns {Map<string, {discordId: string, accountNumber: number, names: string[]}>}
 *          keyed by `${discordId}-${accountNumber}` for groups with >1 entry
 */
function getAccountConflicts(lineupPlayers, players) {
  const playerByName = new Map();
  for (const p of players) playerByName.set(p.name, p);

  const groups = new Map();
  for (const lp of lineupPlayers) {
    const name = lp.player_name;
    if (!name || name.startsWith('[PUB]')) continue;
    const p = playerByName.get(name);
    if (!p || !p.discord_id) continue;
    const accountNum = p.account_number || 1;
    const key = `${p.discord_id}-${accountNum}`;
    if (!groups.has(key)) {
      groups.set(key, { discordId: p.discord_id, accountNumber: accountNum, names: [] });
    }
    groups.get(key).names.push(name);
  }

  const conflicts = new Map();
  for (const [key, group] of groups) {
    if (group.names.length > 1) conflicts.set(key, group);
  }
  return conflicts;
}

/**
 * Would adding `candidate` to the existing roster create a same-account conflict?
 * @param {Array<{player_name: string}>} lineupPlayers
 * @param {{name: string, discord_id: string, account_number: number|null}} candidate
 * @param {Array} allPlayers
 * @returns {{conflicts: boolean, withName: string|null}}
 */
function wouldConflict(lineupPlayers, candidate, allPlayers) {
  const accountNum = candidate.account_number || 1;
  const playerByName = new Map();
  for (const p of allPlayers) playerByName.set(p.name, p);

  for (const lp of lineupPlayers) {
    const existing = playerByName.get(lp.player_name);
    if (!existing || !existing.discord_id) continue;
    if (existing.name === candidate.name) continue;
    if (
      existing.discord_id === candidate.discord_id &&
      (existing.account_number || 1) === accountNum
    ) {
      return { conflicts: true, withName: existing.name };
    }
  }
  return { conflicts: false, withName: null };
}

module.exports = { getAccountConflicts, wouldConflict };

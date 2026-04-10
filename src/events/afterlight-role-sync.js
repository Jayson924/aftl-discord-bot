const { Events } = require('discord.js');
const supabase = require('../supabase');

const AFTERLIGHT_ROLE_NAME = 'Afterlight';

function hasAfterlightRole(member) {
  const roleId = process.env.AFTERLIGHT_ROLE_ID;
  if (roleId) return member.roles.cache.has(roleId);
  return member.roles.cache.some(
    (r) => r.name.toLowerCase() === AFTERLIGHT_ROLE_NAME.toLowerCase()
  );
}

module.exports = {
  name: Events.GuildMemberUpdate,
  async execute(oldMember, newMember) {
    const hadRole = hasAfterlightRole(oldMember);
    const hasRole = hasAfterlightRole(newMember);

    if (hadRole === hasRole) return;

    const newAppRole = hasRole ? 'guildmate' : 'guest';
    const action = hasRole ? 'Promoted' : 'Demoted';
    const discordId = newMember.id;

    const { data, error } = await supabase
      .from('app_users')
      .update({ role: newAppRole })
      .eq('discord_id', discordId)
      .select('discord_id, role');

    if (error) {
      console.error(
        `Failed to sync ${newMember.user.tag} to ${newAppRole}:`,
        error
      );
      return;
    }

    if (!data || data.length === 0) {
      console.log(
        `[role-sync] ${newMember.user.tag} Afterlight role ${hasRole ? 'added' : 'removed'} but has no app_users row yet`
      );
      return;
    }

    console.log(`[role-sync] ${action} ${newMember.user.tag} to ${newAppRole} on web app`);
  },
};

const { Events } = require('discord.js');
const { syncUserRaidRoles } = require('../lib/raidRoleSync');

// Grant raid-need roles to new (or returning) guild members based on their
// current characters. No-op if they have no app_users row / no characters.
module.exports = {
  name: Events.GuildMemberAdd,
  async execute(member) {
    try {
      await syncUserRaidRoles(member.guild, member.id);
    } catch (err) {
      console.error(`[raid-role-join] sync failed for ${member.user.tag}:`, err);
    }
  },
};

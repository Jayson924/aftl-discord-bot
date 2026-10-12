const { Events } = require('discord.js');
const { siteRoleFor, syncMemberToSite } = require('../lib/siteRoleSync');

// Discord role changes that move someone's site role update app_users.role.
module.exports = {
  name: Events.GuildMemberUpdate,
  async execute(oldMember, newMember) {
    if (siteRoleFor(oldMember) === siteRoleFor(newMember)) return;
    await syncMemberToSite(newMember.guild, newMember.id, { member: newMember });
  },
};

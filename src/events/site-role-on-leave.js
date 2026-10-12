const { Events } = require('discord.js');
const { syncMemberToSite } = require('../lib/siteRoleSync');

// Leaving the server makes someone a guest on the web app.
module.exports = {
  name: Events.GuildMemberRemove,
  async execute(member) {
    await syncMemberToSite(member.guild, member.id, { left: true });
  },
};

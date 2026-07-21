// Removing the ✅ reaction un-marks that user's gold-share confirmation, and
// cancels any pending auto-close (handled inside refreshPayoutState).

const { Events } = require('discord.js');
const { handlePayoutReaction } = require('../lib/lootPayout');

module.exports = {
  name: Events.MessageReactionRemove,
  async execute(reaction, user) {
    await handlePayoutReaction(reaction, user, false);
  },
};

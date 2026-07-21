// A ✅ reaction on a loot-thread payout message = "I got my gold share."
// Marks the reacting user's party character(s) as paid in lineup_payouts.

const { Events } = require('discord.js');
const { handlePayoutReaction } = require('../lib/lootPayout');

module.exports = {
  name: Events.MessageReactionAdd,
  async execute(reaction, user) {
    await handlePayoutReaction(reaction, user, true);
  },
};

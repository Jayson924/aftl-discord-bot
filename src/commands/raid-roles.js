const { SlashCommandBuilder } = require('discord.js');
const {
  RAID_ROLE_ENV_MAP,
  getConfiguredRoles,
  syncUserRaidRoles,
  syncAllUsers,
} = require('../lib/raidRoleSync');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('raid-roles')
    .setDescription('Manage dynamic raid-need roles')
    .addSubcommand(sub =>
      sub
        .setName('sync')
        .setDescription('Reconcile raid-need roles (everyone, or a single user)')
        .addUserOption(opt =>
          opt.setName('user').setDescription('Sync just this user').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('status').setDescription('Show configured raid-need roles and member counts')
    ),

  async execute(interaction) {
    if (interaction.user.id !== process.env.OWNER_ID) {
      await interaction.reply({ content: 'This command is restricted.', ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'status') {
      const configured = getConfiguredRoles();
      const lines = [];
      for (const [raidType, envVar] of Object.entries(RAID_ROLE_ENV_MAP)) {
        const roleId = configured[raidType];
        if (!roleId) {
          lines.push(`- **${raidType}** — _not configured_ (set \`${envVar}\`)`);
          continue;
        }
        const role = interaction.guild.roles.cache.get(roleId);
        if (!role) {
          lines.push(`- **${raidType}** — role \`${roleId}\` not found in this guild`);
        } else {
          lines.push(`- **${raidType}** — ${role} (${role.members.size} member${role.members.size === 1 ? '' : 's'})`);
        }
      }
      await interaction.reply({
        content: `**Raid-need roles**\n${lines.join('\n')}`,
        ephemeral: true,
      });
      return;
    }

    // sync
    const target = interaction.options.getUser('user');

    if (target) {
      await interaction.deferReply({ ephemeral: true });
      const result = await syncUserRaidRoles(interaction.guild, target.id);
      if (result.skipped) {
        await interaction.editReply(`Skipped <@${target.id}>: \`${result.skipped}\``);
      } else {
        await interaction.editReply(`Synced <@${target.id}>: **+${result.added}** / **-${result.removed}**`);
      }
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const { total, synced } = await syncAllUsers(interaction.guild);
    await interaction.editReply(`Full sync complete: **${synced}/${total}** users processed. Check bot logs for per-user details.`);
  },
};

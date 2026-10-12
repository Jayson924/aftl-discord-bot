const { SlashCommandBuilder } = require('discord.js');
const { ROLE_MAP, discordRole, syncMemberToSite, reconcileAll } = require('../lib/siteRoleSync');

const MAX_LINES = 40;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('site-roles')
    .setDescription('Sync web app roles from Discord roles')
    .addSubcommand(sub =>
      sub.setName('preview').setDescription('List the web app roles a sync from Discord would change')
    )
    .addSubcommand(sub =>
      sub
        .setName('sync')
        .setDescription('Set web app roles from Discord roles (everyone, or a single user)')
        .addUserOption(opt => opt.setName('user').setDescription('Sync just this user').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('status').setDescription('Show which Discord role maps to each web app role')
    ),

  async execute(interaction) {
    if (interaction.user.id !== process.env.OWNER_ID) {
      await interaction.reply({ content: 'This command is restricted.', ephemeral: true });
      return;
    }
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;

    if (sub === 'status') {
      const me = guild.members.me;
      const lines = ROLE_MAP.map(({ site, name, env }) => {
        const role = discordRole(guild, site);
        if (!role) return `- **${site}** — _not found_ (role named "${name}", or set \`${env}\`)`;
        const reach = site === 'admin' ? 'Discord only' : me.roles.highest.comparePositionTo(role) > 0 ? 'bot can assign' : '⚠️ bot role is below it';
        return `- **${site}** ← ${role} (${role.members.size}) · ${reach}`;
      });
      const perm = me.permissions.has('ManageRoles') ? '' : '\n⚠️ The bot is missing **Manage Roles**.';
      await interaction.reply({ content: `**Web app roles**\n${lines.join('\n')}${perm}`, ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const target = interaction.options.getUser('user');
    if (sub === 'sync' && target) {
      const result = await syncMemberToSite(guild, target.id);
      await interaction.editReply(result.skipped
        ? `Skipped <@${target.id}>: \`${result.skipped}\``
        : `<@${target.id}> is **${result.role}** on the web app${result.changed ? ' (updated)' : ' (no change)'}.`);
      return;
    }

    const apply = sub === 'sync';
    const { total, changes } = await reconcileAll(guild, { apply });
    if (!changes.length) {
      await interaction.editReply(`All ${total} web app users already match their Discord roles.`);
      return;
    }
    const lines = changes.slice(0, MAX_LINES).map(c => `- ${c.name}: ${c.from} → **${c.to}**${c.inServer ? '' : ' (not in the server)'}`);
    if (changes.length > MAX_LINES) lines.push(`…and ${changes.length - MAX_LINES} more`);
    const head = apply
      ? `Updated **${changes.length}** of ${total} web app users:`
      : `A sync would change **${changes.length}** of ${total} web app users. Run \`/site-roles sync\` to apply:`;
    await interaction.editReply(`${head}\n${lines.join('\n')}`.slice(0, 1990));
  },
};

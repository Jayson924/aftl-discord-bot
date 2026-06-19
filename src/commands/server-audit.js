const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  OverwriteType,
  ChannelType,
  AttachmentBuilder,
} = require('discord.js');

// Turn a permission flag name like "ManageChannels" into "Manage Channels".
function humanize(flag) {
  return flag.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

function formatPermList(permissions) {
  if (permissions.has(PermissionFlagsBits.Administrator)) {
    return 'Administrator (grants ALL permissions)';
  }
  const names = permissions.toArray();
  if (names.length === 0) return 'None';
  return names.map(humanize).join(', ');
}

// Channel type -> short label + icon for the report.
function channelLabel(channel) {
  switch (channel.type) {
    case ChannelType.GuildText:
      return { icon: '#', kind: 'text' };
    case ChannelType.GuildVoice:
      return { icon: '🔊', kind: 'voice' };
    case ChannelType.GuildAnnouncement:
      return { icon: '📣', kind: 'announcement' };
    case ChannelType.GuildStageVoice:
      return { icon: '🎙️', kind: 'stage' };
    case ChannelType.GuildForum:
      return { icon: '💬', kind: 'forum' };
    case ChannelType.GuildMedia:
      return { icon: '🖼️', kind: 'media' };
    default:
      return { icon: '•', kind: `type ${channel.type}` };
  }
}

function buildReport(guild) {
  const lines = [];
  lines.push(`# Server Permission Audit — ${guild.name}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('> Note: roles are listed highest-to-lowest. Higher roles override lower ones,');
  lines.push('> and channel overwrites override base role permissions. A "Deny" on @everyone');
  lines.push('> at the channel level is the usual way customized servers hide channels.');
  lines.push('');

  // --- Roles -------------------------------------------------------------
  const roles = [...guild.roles.cache.values()].sort((a, b) => b.position - a.position);

  lines.push('## Roles (highest to lowest)');
  lines.push('');
  for (const role of roles) {
    const tags = [];
    if (role.id === guild.id) tags.push('@everyone — base for all members');
    if (role.hoist) tags.push('shown separately');
    if (role.mentionable) tags.push('mentionable');
    if (role.managed) tags.push('managed by integration/bot');
    const tagStr = tags.length ? `  _(${tags.join(', ')})_` : '';

    lines.push(`### ${role.name}${tagStr}`);
    lines.push(`- Members: ${role.members.size}`);
    lines.push(`- Position: ${role.position}`);
    lines.push(`- Base permissions: ${formatPermList(role.permissions)}`);
    lines.push('');
  }

  // --- Channels ----------------------------------------------------------
  lines.push('## Channels & permission overwrites');
  lines.push('');

  const all = [...guild.channels.cache.values()];
  const categories = all
    .filter(c => c.type === ChannelType.GuildCategory)
    .sort((a, b) => a.rawPosition - b.rawPosition);

  const renderChannel = (channel) => {
    const { icon, kind } = channelLabel(channel);
    lines.push(`#### ${icon} ${channel.name}  _(${kind})_`);

    const overwrites = [...channel.permissionOverwrites.cache.values()];
    if (overwrites.length === 0) {
      lines.push('- No custom overwrites (inherits category / base role permissions)');
      lines.push('');
      return;
    }

    for (const ow of overwrites) {
      let target;
      if (ow.type === OverwriteType.Role) {
        const role = guild.roles.cache.get(ow.id);
        target = role ? `@${role.name}` : `role ${ow.id} (deleted?)`;
      } else {
        const member = guild.members.cache.get(ow.id);
        target = member ? `member ${member.user.tag}` : `member ${ow.id}`;
      }

      const allowed = ow.allow.toArray().map(humanize);
      const denied = ow.deny.toArray().map(humanize);
      const parts = [];
      if (allowed.length) parts.push(`Allow: ${allowed.join(', ')}`);
      if (denied.length) parts.push(`Deny: ${denied.join(', ')}`);
      lines.push(`- ${target} — ${parts.length ? parts.join('  |  ') : 'no explicit allow/deny'}`);
    }
    lines.push('');
  };

  for (const category of categories) {
    lines.push(`### 📁 ${category.name}`);
    lines.push('');

    // Category-level overwrites (children inherit these unless they override).
    const catOverwrites = [...category.permissionOverwrites.cache.values()];
    if (catOverwrites.length) {
      lines.push('_Category overwrites (inherited by channels below):_');
      for (const ow of catOverwrites) {
        const role = ow.type === OverwriteType.Role ? guild.roles.cache.get(ow.id) : null;
        const target = role ? `@${role.name}` : (ow.type === OverwriteType.Role ? `role ${ow.id}` : `member ${ow.id}`);
        const allowed = ow.allow.toArray().map(humanize);
        const denied = ow.deny.toArray().map(humanize);
        const parts = [];
        if (allowed.length) parts.push(`Allow: ${allowed.join(', ')}`);
        if (denied.length) parts.push(`Deny: ${denied.join(', ')}`);
        lines.push(`- ${target} — ${parts.length ? parts.join('  |  ') : 'no explicit allow/deny'}`);
      }
      lines.push('');
    }

    const children = all
      .filter(c => c.parentId === category.id)
      .sort((a, b) => a.rawPosition - b.rawPosition);
    if (children.length === 0) {
      lines.push('_(no channels)_');
      lines.push('');
    }
    for (const child of children) renderChannel(child);
  }

  // Channels with no category.
  const orphans = all
    .filter(c => c.type !== ChannelType.GuildCategory && !c.parentId)
    .sort((a, b) => a.rawPosition - b.rawPosition);
  if (orphans.length) {
    lines.push('### 📂 (No category)');
    lines.push('');
    for (const child of orphans) renderChannel(child);
  }

  return lines.join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('server-audit')
    .setDescription('Generate a report of all roles, channels, and their permission overwrites'),

  async execute(interaction) {
    if (interaction.user.id !== process.env.OWNER_ID) {
      await interaction.reply({ content: 'This command is restricted.', ephemeral: true });
      return;
    }

    // Report is potentially sensitive and large — keep it to the invoker.
    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply('This command can only be used inside a server.');
      return;
    }

    // Make sure caches are populated before we read from them.
    await guild.roles.fetch();
    await guild.channels.fetch();
    // Members power role.members.size and member-type overwrite names; best-effort.
    try {
      await guild.members.fetch();
    } catch (err) {
      console.warn('server-audit: could not fetch members, counts may be approximate:', err.message);
    }

    const report = buildReport(guild);
    const file = new AttachmentBuilder(Buffer.from(report, 'utf8'), {
      name: `server-audit-${guild.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.md`,
    });

    await interaction.editReply({
      content: `Permission audit for **${guild.name}** — ${guild.roles.cache.size} roles, ${guild.channels.cache.size} channels. See the attached file.`,
      files: [file],
    });
  },
};

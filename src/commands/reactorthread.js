const {
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  ChannelType,
  ChannelFlags,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  MessageFlags,
} = require('discord.js');

/**
 * Fetch every (non-bot) user who reacted to a message, across all emojis,
 * deduplicated. reaction.users.fetch() returns up to 100 per emoji, which is
 * far more than any raid roster needs.
 */
async function collectReactorIds(message) {
  const ids = new Set();
  for (const reaction of message.reactions.cache.values()) {
    const users = await reaction.users.fetch();
    for (const user of users.values()) {
      if (!user.bot) ids.add(user.id);
    }
  }
  return ids;
}

/**
 * Resolve which forum channel the new post should be created in:
 * the forum the reacted message lives in, otherwise the configured
 * raid-lineups forum (RAID_THREAD_CHANNEL_ID).
 */
async function resolveForum(interaction) {
  const ch = interaction.channel;
  if (ch?.type === ChannelType.GuildForum) return ch;
  if (ch?.parent?.type === ChannelType.GuildForum) return ch.parent;

  const fallbackId = process.env.RAID_THREAD_CHANNEL_ID;
  if (fallbackId) {
    const f = await interaction.client.channels.fetch(fallbackId).catch(() => null);
    if (f?.type === ChannelType.GuildForum) return f;
  }
  return null;
}

module.exports = {
  data: new ContextMenuCommandBuilder()
    .setName('Create thread with reactions')
    .setType(ApplicationCommandType.Message),

  // Right-click a message -> prompt for the thread name via a modal. The
  // submit is routed back to handleModal() (see index.js). The target
  // message id is carried on the modal's customId.
  async execute(interaction) {
    // Default name based on the source thread/channel.
    const sourceName = interaction.channel?.isThread?.()
      ? interaction.channel.name
      : interaction.channel?.name;
    const defaultName = sourceName ? `Reactors — ${sourceName}` : 'Reactors thread';

    const nameInput = new TextInputBuilder()
      .setCustomId('name')
      .setLabel('Thread name')
      .setStyle(TextInputStyle.Short)
      .setMaxLength(100)
      .setRequired(true)
      .setValue(defaultName.slice(0, 100));

    const modal = new ModalBuilder()
      .setCustomId(`reactorthread:${interaction.targetId}`)
      .setTitle('Create reactor thread')
      .addComponents(new ActionRowBuilder().addComponents(nameInput));

    await interaction.showModal(modal);
  },

  // Handles the modal submit: gather reactors from the target message and
  // create the named forum post.
  async handleModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const messageId = interaction.customId.split(':')[1];
    let threadName = interaction.fields.getTextInputValue('name').trim() || 'Reactors thread';
    if (threadName.length > 100) threadName = threadName.slice(0, 100);

    const message = await interaction.channel?.messages.fetch(messageId).catch(() => null);
    if (!message) {
      await interaction.editReply('Couldn\'t find that message anymore.');
      return;
    }

    const reactorIds = await collectReactorIds(message);
    if (reactorIds.size === 0) {
      await interaction.editReply('That message has no reactions (from non-bots) to gather.');
      return;
    }

    const forum = await resolveForum(interaction);
    if (!forum) {
      await interaction.editReply(
        'Couldn\'t find a forum to post in. Run this on a message inside the raid-lineups forum, or set RAID_THREAD_CHANNEL_ID to a forum channel.',
      );
      return;
    }

    // Forums can be configured to require a tag on every post.
    const appliedTags = forum.flags?.has(ChannelFlags.RequireTag) && forum.availableTags?.length
      ? [forum.availableTags[0].id]
      : undefined;

    const embed = new EmbedBuilder()
      .setTitle('Reactor thread')
      .setDescription(`Gathered **${reactorIds.size}** member(s) who reacted to [this message](${message.url}).`)
      .setColor(0x5865f2);

    const thread = await forum.threads.create({
      name: threadName,
      message: { embeds: [embed] },
      appliedTags,
      reason: `Reactor thread created by ${interaction.user.tag}`,
    });

    // Ping the reactors in a follow-up so they actually get notified.
    const ids = [...reactorIds];
    const pingList = ids.map(id => `<@${id}>`).join(' ');
    await thread.send({
      content: pingList,
      allowedMentions: { users: ids },
    });

    await interaction.editReply(`Created ${thread} with ${reactorIds.size} reactor(s).`);
  },
};

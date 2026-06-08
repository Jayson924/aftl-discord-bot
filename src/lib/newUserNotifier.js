// New-user review notifier.
//
// When a new `app_users` row is inserted (someone logs into the web app via
// Discord for the first time, created with role 'guest'), the bot posts a
// notification to a review channel with two buttons:
//   - "Give Guildmate Role" → sets their web app role (app_users.role) to
//     guildmate. (Web app role only — no Discord role is touched.)
//   - "Ignore" → just removes the buttons so the notification is acknowledged.
//
// Both actions are gated to web-app admins, matching the sign-up approval flow.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const supabase = require('../supabase');

// Channel the review notifications go to. Override with NEW_USER_CHANNEL_ID.
const DEFAULT_CHANNEL_ID = '1502370116258500688';

function getChannelId() {
  return process.env.NEW_USER_CHANNEL_ID || DEFAULT_CHANNEL_ID;
}

function buildEmbed(user) {
  const displayName = user.display_name || user.username || 'Unknown';

  const embed = new EmbedBuilder()
    .setTitle('🆕 New User')
    .setColor(0xf4c430)
    .addFields(
      { name: 'Name', value: displayName, inline: true },
      { name: 'Username', value: user.username || '—', inline: true },
    );

  // Mention inside an embed field renders as a clickable name but never pings.
  if (user.discord_id) {
    embed.addFields({ name: 'Discord', value: `<@${user.discord_id}>`, inline: false });
  }
  if (user.avatar_url) embed.setThumbnail(user.avatar_url);
  embed.setTimestamp(new Date());
  return embed;
}

function buildButtons(discordId) {
  const approve = new ButtonBuilder()
    .setCustomId(`newuser:approve:${discordId}`)
    .setLabel('Give Guildmate Role')
    .setStyle(ButtonStyle.Success);
  const ignore = new ButtonBuilder()
    .setCustomId(`newuser:ignore:${discordId}`)
    .setLabel('Ignore')
    .setStyle(ButtonStyle.Secondary);
  return new ActionRowBuilder().addComponents(approve, ignore);
}

async function sendNewUserNotification(client, user) {
  const channelId = getChannelId();
  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    console.error(`[new-user] cannot fetch channel ${channelId}:`, err.message);
    return;
  }
  if (!channel?.isTextBased?.()) {
    console.error(`[new-user] channel ${channelId} is not text-based`);
    return;
  }

  await channel
    .send({
      embeds: [buildEmbed(user)],
      components: [buildButtons(user.discord_id)],
      allowedMentions: { parse: [] },
    })
    .catch(err => console.error('[new-user] send failed:', err.message));
}

// === Realtime subscription ===

function subscribeNewUsers(client) {
  return supabase
    .channel('new-user-notifier-app-users')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'app_users' },
      (payload) => {
        const row = payload.new || {};
        if (!row.discord_id) return;
        // New users are created as 'guest'; skip anyone already promoted.
        if (row.role === 'guildmate' || row.role === 'admin') return;
        sendNewUserNotification(client, row).catch(err =>
          console.error('[new-user] notify failed:', err)
        );
      }
    )
    .subscribe((status) => {
      console.log(`[new-user] app_users channel: ${status}`);
    });
}

function startNewUserNotifier(client) {
  console.log(`[new-user] starting notifier → channel ${getChannelId()}`);
  subscribeNewUsers(client);
}

// === Button interaction handling ===

async function isAdmin(discordId) {
  const { data, error } = await supabase
    .from('app_users')
    .select('role')
    .eq('discord_id', discordId)
    .maybeSingle();
  if (error) {
    console.error('[new-user] admin check failed:', error);
    return false;
  }
  return data?.role === 'admin';
}

async function handleIgnore(interaction) {
  const embed = interaction.message.embeds[0]
    ? EmbedBuilder.from(interaction.message.embeds[0]).setColor(0x747f8d)
    : null;
  await interaction.update({
    content: `🚫 Ignored by <@${interaction.user.id}>.`,
    embeds: embed ? [embed] : [],
    components: [],
  });
}

async function handleApprove(interaction, targetDiscordId) {
  const { data: user, error } = await supabase
    .from('app_users')
    .select('discord_id, display_name, username, role')
    .eq('discord_id', targetDiscordId)
    .maybeSingle();

  if (error || !user) {
    return interaction.update({
      content: '⚠️ User not found — their account may have been removed.',
      embeds: [],
      components: [],
    });
  }

  const name = user.display_name || user.username || `<@${targetDiscordId}>`;

  if (user.role === 'admin') {
    return interaction.reply({
      content: `${name} is an admin — leaving their role unchanged.`,
      ephemeral: true,
    });
  }

  // Update the web app role only (no Discord role is touched).
  const { error: roleErr } = await supabase
    .from('app_users')
    .update({ role: 'guildmate' })
    .eq('discord_id', targetDiscordId)
    .neq('role', 'admin');
  if (roleErr) {
    console.error('[new-user] role update failed:', roleErr);
    return interaction.reply({
      content: 'Failed to update the user on the web app. Please try again.',
      ephemeral: true,
    });
  }

  const embed = interaction.message.embeds[0]
    ? EmbedBuilder.from(interaction.message.embeds[0]).setColor(0x4caf50)
    : null;
  await interaction.update({
    content: `**${name}** now has updated permissions on the raid manager.`,
    embeds: embed ? [embed] : [],
    components: [],
  });
}

async function handleNewUserButton(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('newuser:')) return;

  const [, action, targetDiscordId] = interaction.customId.split(':');

  if (!(await isAdmin(interaction.user.id))) {
    return interaction.reply({
      content: 'Only admins can action new-user reviews.',
      ephemeral: true,
    });
  }

  try {
    if (action === 'ignore') return await handleIgnore(interaction);
    if (action === 'approve') return await handleApprove(interaction, targetDiscordId);
  } catch (err) {
    console.error(`[new-user] error handling ${interaction.customId}:`, err);
    const msg = { content: 'Something went wrong.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
}

module.exports = { startNewUserNotifier, handleNewUserButton };

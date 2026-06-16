// New-character review notifier.
//
// When a new `players` row is inserted (someone adds a character on the web
// app), the bot posts a notification to a review channel with two buttons:
//   - "In Guild" → marks the character whitelisted (players.whitelisted = true),
//     i.e. recognized as a guild character. Mirrors the web app's
//     togglePlayerWhitelist(id, true).
//   - "Ignore" → dismisses it from review (players.whitelist_ignored = true),
//     mirroring the web app's dismissPlayerReview(). Clears it from the web
//     "New Characters" admin queue too.
//
// Both actions are gated to web-app admins, matching the new-user flow.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const supabase = require('../supabase');

// Channel the review notifications go to. Defaults to the new-user review
// channel so characters land in the same place unless split out explicitly.
const DEFAULT_CHANNEL_ID = '1513384145978523678';

function getChannelId() {
  return process.env.NEW_CHARACTER_CHANNEL_ID
    || process.env.NEW_USER_CHANNEL_ID
    || DEFAULT_CHANNEL_ID;
}

function buildEmbed(player) {
  const embed = new EmbedBuilder()
    .setTitle('🆕 New Character')
    .setColor(0xf4c430)
    .addFields(
      { name: 'Character', value: player.name || 'Unknown', inline: true },
      { name: 'Class', value: player.role || '—', inline: true },
    );

  if (player.account_number && player.account_number > 1) {
    embed.addFields({ name: 'Account', value: `#${player.account_number}`, inline: true });
  }

  // Owner — mention inside an embed field renders as a clickable name, no ping.
  const ownerValue = player.discord_id
    ? `<@${player.discord_id}>${player.discord_username ? ` (${player.discord_username})` : ''}`
    : (player.discord_username || '—');
  embed.addFields({ name: 'Owner', value: ownerValue, inline: false });

  embed.setTimestamp(new Date());
  return embed;
}

function buildButtons(playerId) {
  const approve = new ButtonBuilder()
    .setCustomId(`newchar:approve:${playerId}`)
    .setLabel('In Guild')
    .setStyle(ButtonStyle.Success);
  const ignore = new ButtonBuilder()
    .setCustomId(`newchar:ignore:${playerId}`)
    .setLabel('Ignore')
    .setStyle(ButtonStyle.Secondary);
  return new ActionRowBuilder().addComponents(approve, ignore);
}

async function sendNewCharacterNotification(client, player) {
  const channelId = getChannelId();
  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    console.error(`[new-char] cannot fetch channel ${channelId}:`, err.message);
    return;
  }
  if (!channel?.isTextBased?.()) {
    console.error(`[new-char] channel ${channelId} is not text-based`);
    return;
  }

  await channel
    .send({
      embeds: [buildEmbed(player)],
      components: [buildButtons(player.id)],
      allowedMentions: { parse: [] },
    })
    .then(() => console.log(`[new-char] posted notification for ${player.id} (${player.name})`))
    .catch(err => console.error('[new-char] send failed:', err.message));
}

// === Realtime subscription ===

function subscribeNewCharacters(client) {
  return supabase
    .channel('new-character-notifier-players')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'players' },
      (payload) => {
        const row = payload.new || {};
        console.log(`[new-char] INSERT received — id=${row.id} name=${row.name}`);
        if (!row.id) return;
        // Skip characters that are already actioned (defensive — fresh inserts
        // normally aren't whitelisted/ignored/excluded yet).
        if (row.whitelisted === true || row.whitelist_ignored === true || row.exclude === true) return;
        sendNewCharacterNotification(client, row).catch(err =>
          console.error('[new-char] notify failed:', err)
        );
      }
    )
    .subscribe((status) => {
      console.log(`[new-char] players channel: ${status}`);
    });
}

function startNewCharacterNotifier(client) {
  console.log(`[new-char] starting notifier → channel ${getChannelId()}`);
  subscribeNewCharacters(client);
}

// === Button interaction handling ===

async function isAdmin(discordId) {
  const { data, error } = await supabase
    .from('app_users')
    .select('role')
    .eq('discord_id', discordId)
    .maybeSingle();
  if (error) {
    console.error('[new-char] admin check failed:', error);
    return false;
  }
  return data?.role === 'admin';
}

async function handleIgnore(interaction, playerId) {
  const { data: player } = await supabase
    .from('players')
    .select('id, name')
    .eq('id', playerId)
    .maybeSingle();

  // Dismiss from review on the web app too (mirrors dismissPlayerReview).
  const { error } = await supabase
    .from('players')
    .update({ whitelist_ignored: true })
    .eq('id', playerId);
  if (error) {
    console.error('[new-char] ignore update failed:', error);
    return interaction.reply({
      content: 'Failed to dismiss the character on the web app. Please try again.',
      ephemeral: true,
    });
  }

  const name = player?.name || 'Character';
  const embed = interaction.message.embeds[0]
    ? EmbedBuilder.from(interaction.message.embeds[0]).setColor(0x747f8d)
    : null;
  await interaction.update({
    content: `🚫 **${name}** ignored by <@${interaction.user.id}>.`,
    embeds: embed ? [embed] : [],
    components: [],
  });
}

async function handleApprove(interaction, playerId) {
  const { data: player, error } = await supabase
    .from('players')
    .select('id, name')
    .eq('id', playerId)
    .maybeSingle();

  if (error || !player) {
    return interaction.update({
      content: '⚠️ Character not found — it may have been removed.',
      embeds: [],
      components: [],
    });
  }

  // Mark whitelisted on the web app (mirrors togglePlayerWhitelist(id, true)).
  const { error: updateErr } = await supabase
    .from('players')
    .update({ whitelisted: true })
    .eq('id', playerId);
  if (updateErr) {
    console.error('[new-char] whitelist update failed:', updateErr);
    return interaction.reply({
      content: 'Failed to update the character on the web app. Please try again.',
      ephemeral: true,
    });
  }

  const embed = interaction.message.embeds[0]
    ? EmbedBuilder.from(interaction.message.embeds[0]).setColor(0x4caf50)
    : null;
  await interaction.update({
    content: `**${player.name}** is now marked as in the guild.`,
    embeds: embed ? [embed] : [],
    components: [],
  });
}

async function handleNewCharacterButton(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('newchar:')) return;

  // playerId is a UUID (no colons), so a 3-way split is safe.
  const [, action, playerId] = interaction.customId.split(':');

  if (!(await isAdmin(interaction.user.id))) {
    return interaction.reply({
      content: 'Only admins can action new-character reviews.',
      ephemeral: true,
    });
  }

  try {
    if (action === 'ignore') return await handleIgnore(interaction, playerId);
    if (action === 'approve') return await handleApprove(interaction, playerId);
  } catch (err) {
    console.error(`[new-char] error handling ${interaction.customId}:`, err);
    const msg = { content: 'Something went wrong.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
}

module.exports = { startNewCharacterNotifier, handleNewCharacterButton };

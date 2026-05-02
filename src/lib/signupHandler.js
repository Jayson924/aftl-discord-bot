const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');
const crypto = require('crypto');
const supabase = require('../supabase');
const { wouldConflict } = require('./accountConflicts');
const { updateRaidThread } = require('./updateRaidThread');

// In-memory stash for multi-step request state. Keyed by short request id.
// Lost on bot restart — acceptable for v1: pending approvals are short-lived.
const stash = new Map();
const STASH_TTL_MS = 30 * 60 * 1000;

function makeRequestId() {
  return crypto.randomBytes(6).toString('hex');
}

function setStash(id, data) {
  stash.set(id, data);
  setTimeout(() => stash.delete(id), STASH_TTL_MS).unref?.();
}

// === Data helpers ===

async function getLineupWithPlayers(lineupId) {
  const { data, error } = await supabase
    .from('lineups')
    .select('*, lineup_players (player_name, slot_position, player_id, uses_ticket, pilot_name)')
    .eq('id', lineupId)
    .single();
  if (error) throw error;
  return data;
}

async function getCharactersOwnedBy(discordId) {
  const { data, error } = await supabase
    .from('players')
    .select('id, name, discord_id, account_number, exclude, exclude_label')
    .eq('discord_id', discordId);
  if (error) throw error;
  return data || [];
}

async function getPlayersByName(names) {
  if (!names || names.length === 0) return [];
  const { data, error } = await supabase
    .from('players')
    .select('name, discord_id, account_number')
    .in('name', names);
  if (error) throw error;
  return data || [];
}

async function getAppUser(discordId) {
  const { data, error } = await supabase
    .from('app_users')
    .select('role, exclude, exclude_label, display_name, username')
    .eq('discord_id', discordId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function nextEmptySlot(lineup) {
  const lineupSize = lineup.raid_type === '4-man' ? 4 : 8;
  const taken = new Set((lineup.lineup_players || []).map(lp => lp.slot_position));
  for (let i = 1; i <= lineupSize; i++) {
    if (!taken.has(i)) return i;
  }
  return null;
}

async function insertLineupPlayer(lineupId, slot, name, playerId, usesTicket) {
  const { error } = await supabase.from('lineup_players').insert({
    lineup_id: lineupId,
    slot_position: slot,
    player_name: name,
    player_id: playerId,
    uses_ticket: !!usesTicket,
    pilot_name: null,
  });
  if (error) throw error;
}

async function deleteLineupPlayerByName(lineupId, playerName) {
  const { error } = await supabase
    .from('lineup_players')
    .delete()
    .eq('lineup_id', lineupId)
    .eq('player_name', playerName);
  if (error) throw error;
}

async function refreshThread(client, lineupId) {
  try {
    await updateRaidThread({ client, lineupId });
  } catch (err) {
    console.error(`[signup] updateRaidThread failed for ${lineupId}:`, err.message);
  }
}

// === Reply helper ===

// Updateable contexts: any select menu (always in our own ephemeral), and
// approve/deny buttons (which live on the public approval message). Plain
// Join/Drop buttons live on the embed — we must NOT update that, so reply
// with a fresh ephemeral instead.
function isUpdateableContext(interaction) {
  if (interaction.isStringSelectMenu()) return true;
  if (interaction.isButton()) {
    return interaction.customId.startsWith('signup:approve:')
        || interaction.customId.startsWith('signup:deny:');
  }
  return false;
}

async function respondTo(interaction, payload) {
  if (isUpdateableContext(interaction)) {
    return await interaction.update(payload);
  }
  return await interaction.reply({ ...payload, ephemeral: true });
}

// === Top-level dispatch ===

async function handle(interaction, client) {
  const customId = interaction.customId;
  if (!customId || !customId.startsWith('signup:')) return false;

  try {
    const parts = customId.split(':');
    const action = parts[1];

    if (interaction.isButton()) {
      if (action === 'join') return void await handleJoinClick(interaction, parts[2]);
      if (action === 'drop') return void await handleDropClick(interaction, parts[2], client);
      if (action === 'approve') return void await handleApproveClick(interaction, parts[2], client);
      if (action === 'deny') return void await handleDenyClick(interaction, parts[2]);
    }
    if (interaction.isStringSelectMenu()) {
      if (action === 'pickchar') return void await handlePickChar(interaction, parts[2]);
      if (action === 'pickdrop') return void await handlePickDrop(interaction, parts[2], client);
      if (action === 'ticket') return void await handleTicketPick(interaction, parts[2], client);
    }
    return true;
  } catch (err) {
    console.error(`[signup] Error handling ${customId}:`, err);
    const msg = { content: 'Something went wrong.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      try { await interaction.followUp(msg); } catch {}
    } else {
      try { await interaction.reply(msg); } catch {}
    }
    return true;
  }
}

// === Join flow ===

async function handleJoinClick(interaction, lineupId) {
  const characters = await getCharactersOwnedBy(interaction.user.id);

  if (characters.length === 0) {
    return await postApprovalRequest(interaction, lineupId, null, false, 'unregistered user');
  }

  if (characters.length === 1) {
    return await proceedAfterChar(interaction, lineupId, characters[0]);
  }

  return await showCharacterPicker(interaction, lineupId, characters);
}

async function showCharacterPicker(interaction, lineupId, characters) {
  const options = characters.slice(0, 25).map(c => {
    const opt = { label: c.name, value: c.name };
    const bits = [];
    if (c.account_number) bits.push(`Account ${c.account_number}`);
    if (c.exclude) bits.push('excluded');
    if (bits.length > 0) opt.description = bits.join(' · ');
    return opt;
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`signup:pickchar:${lineupId}`)
    .setPlaceholder('Choose a character')
    .addOptions(options);

  await respondTo(interaction, {
    content: 'Which character do you want to sign up?',
    components: [new ActionRowBuilder().addComponents(select)],
  });
}

async function handlePickChar(interaction, lineupId) {
  const playerName = interaction.values[0];
  const characters = await getCharactersOwnedBy(interaction.user.id);
  const character = characters.find(c => c.name === playerName);
  if (!character) {
    return await respondTo(interaction, { content: 'Character not found.', components: [] });
  }
  return await proceedAfterChar(interaction, lineupId, character);
}

async function proceedAfterChar(interaction, lineupId, character) {
  const lineup = await getLineupWithPlayers(lineupId);
  if (lineup.raid_type === 'Classic') {
    return await showTicketPicker(interaction, lineup, character);
  }
  return await evaluateAndAct(interaction, lineup, character, false);
}

async function showTicketPicker(interaction, lineup, character) {
  const requestId = makeRequestId();
  setStash(requestId, {
    lineupId: lineup.id,
    playerName: character.name,
    discordId: interaction.user.id,
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`signup:ticket:${requestId}`)
    .setPlaceholder('Pania ticket?')
    .addOptions(
      { label: 'Yes', value: 'yes', description: 'Use a Pania ticket for this clear' },
      { label: 'No', value: 'no' },
    );

  await respondTo(interaction, {
    content: `**${character.name}** — Pania ticket?`,
    components: [new ActionRowBuilder().addComponents(select)],
  });
}

async function handleTicketPick(interaction, requestId, client) {
  const data = stash.get(requestId);
  if (!data) {
    return await respondTo(interaction, {
      content: 'This prompt expired. Click Join again.',
      components: [],
    });
  }
  if (data.discordId !== interaction.user.id) {
    return await interaction.reply({ content: "That prompt isn't for you.", ephemeral: true });
  }

  const usesTicket = interaction.values[0] === 'yes';
  const lineup = await getLineupWithPlayers(data.lineupId);
  const characters = await getCharactersOwnedBy(interaction.user.id);
  const character = characters.find(c => c.name === data.playerName);
  stash.delete(requestId);

  if (!character) {
    return await respondTo(interaction, { content: 'Character not found.', components: [] });
  }
  return await evaluateAndAct(interaction, lineup, character, usesTicket);
}

async function evaluateAndAct(interaction, lineup, character, usesTicket) {
  const appUser = await getAppUser(interaction.user.id);

  // Already in this lineup?
  const already = (lineup.lineup_players || []).some(lp => lp.player_name === character.name);
  if (already) {
    return await respondTo(interaction, {
      content: `**${character.name}** is already in this lineup.`,
      components: [],
    });
  }

  // Lineup full?
  const slot = nextEmptySlot(lineup);
  if (slot === null) {
    return await respondTo(interaction, {
      content: 'This lineup is already full.',
      components: [],
    });
  }

  // Decide: auto-add or send for approval
  const reasons = [];
  if (!appUser || appUser.role !== 'guildmate') {
    reasons.push(appUser?.role === 'admin' ? null : 'not a guildmate');
  }
  if (appUser?.exclude) {
    reasons.push(`user excluded${appUser.exclude_label ? ` (${appUser.exclude_label})` : ''}`);
  }
  if (character.exclude) {
    reasons.push(`character excluded${character.exclude_label ? ` (${character.exclude_label})` : ''}`);
  }

  // Account conflict — port of getAccountConflicts() from lineup-editor.jsx
  const allInLineup = await getPlayersByName(
    (lineup.lineup_players || []).map(lp => lp.player_name)
  );
  const conflict = wouldConflict(
    lineup.lineup_players || [],
    { name: character.name, discord_id: character.discord_id, account_number: character.account_number },
    allInLineup,
  );
  if (conflict.conflicts) {
    reasons.push(`same-account conflict with ${conflict.withName}`);
  }

  const blocking = reasons.filter(Boolean);
  if (blocking.length > 0) {
    return await postApprovalRequest(
      interaction,
      lineup.id,
      character,
      usesTicket,
      blocking.join('; '),
    );
  }

  // Auto-add path — guildmate (or admin), no exclusions, no conflict.
  await insertLineupPlayer(lineup.id, slot, character.name, character.id, usesTicket);
  await respondTo(interaction, {
    content: `✅ Added **${character.name}** to slot ${slot}${usesTicket ? ' 🎟️' : ''}.`,
    components: [],
  });
  await refreshThread(interaction.client, lineup.id);
}

// === Approval flow ===

async function postApprovalRequest(interaction, lineupId, character, usesTicket, reason) {
  const requestId = makeRequestId();
  setStash(requestId, {
    lineupId,
    playerName: character?.name || null,
    playerId: character?.id || null,
    usesTicket: !!usesTicket,
    requesterId: interaction.user.id,
  });

  const approveBtn = new ButtonBuilder()
    .setCustomId(`signup:approve:${requestId}`)
    .setLabel('Approve')
    .setStyle(ButtonStyle.Success);
  const denyBtn = new ButtonBuilder()
    .setCustomId(`signup:deny:${requestId}`)
    .setLabel('Deny')
    .setStyle(ButtonStyle.Danger);

  const charLine = character
    ? `Character: **${character.name}**${usesTicket ? ' — Pania ticket 🎟️' : ''}`
    : 'Character: _none registered_';

  const content = [
    `🛂 **Sign-up needs admin review** — <@${interaction.user.id}>`,
    charLine,
    `Reason: ${reason}`,
  ].join('\n');

  const channel = interaction.channel;
  if (!channel) {
    return await respondTo(interaction, {
      content: 'Could not post approval request — channel unavailable.',
      components: [],
    });
  }

  await channel.send({
    content,
    components: [new ActionRowBuilder().addComponents(approveBtn, denyBtn)],
    allowedMentions: { users: [interaction.user.id] },
  });

  await respondTo(interaction, {
    content: '⏳ Your sign-up has been sent for admin review.',
    components: [],
  });
}

async function handleApproveClick(interaction, requestId, client) {
  const adminUser = await getAppUser(interaction.user.id);
  if (!adminUser || adminUser.role !== 'admin') {
    return await interaction.reply({ content: 'Only admins can approve sign-ups.', ephemeral: true });
  }

  const data = stash.get(requestId);
  if (!data) {
    return await interaction.reply({
      content: 'This request has expired or was already handled.',
      ephemeral: true,
    });
  }

  if (!data.playerName || !data.playerId) {
    stash.delete(requestId);
    return await respondTo(interaction, {
      content: `${interaction.message.content}\n\n❌ **Cannot approve** — no registered character. Have them add one on the web app first.`,
      components: [],
    });
  }

  const lineup = await getLineupWithPlayers(data.lineupId);
  const slot = nextEmptySlot(lineup);
  if (slot === null) {
    return await respondTo(interaction, {
      content: `${interaction.message.content}\n\n⚠️ **Lineup is full** — cannot add.`,
      components: [],
    });
  }
  const already = (lineup.lineup_players || []).some(lp => lp.player_name === data.playerName);
  if (already) {
    stash.delete(requestId);
    return await respondTo(interaction, {
      content: `${interaction.message.content}\n\n⚠️ **Already in lineup** — no action taken.`,
      components: [],
    });
  }

  await insertLineupPlayer(data.lineupId, slot, data.playerName, data.playerId, data.usesTicket);
  stash.delete(requestId);
  await respondTo(interaction, {
    content: `${interaction.message.content}\n\n✅ **Approved by <@${interaction.user.id}>** — added to slot ${slot}.`,
    components: [],
  });
  await refreshThread(client, data.lineupId);
}

async function handleDenyClick(interaction, requestId) {
  const adminUser = await getAppUser(interaction.user.id);
  if (!adminUser || adminUser.role !== 'admin') {
    return await interaction.reply({ content: 'Only admins can deny sign-ups.', ephemeral: true });
  }
  stash.delete(requestId);
  await respondTo(interaction, {
    content: `${interaction.message.content}\n\n❌ **Denied by <@${interaction.user.id}>**.`,
    components: [],
  });
}

// === Drop flow ===

async function handleDropClick(interaction, lineupId, client) {
  const lineup = await getLineupWithPlayers(lineupId);
  const myCharacters = await getCharactersOwnedBy(interaction.user.id);
  const myNames = new Set(myCharacters.map(c => c.name));
  const myInLineup = (lineup.lineup_players || []).filter(lp => myNames.has(lp.player_name));

  if (myInLineup.length === 0) {
    return await interaction.reply({
      content: 'You have no characters in this lineup.',
      ephemeral: true,
    });
  }

  if (myInLineup.length === 1) {
    await deleteLineupPlayerByName(lineupId, myInLineup[0].player_name);
    await interaction.reply({
      content: `🚪 Removed **${myInLineup[0].player_name}** from the lineup.`,
      ephemeral: true,
    });
    await refreshThread(client, lineupId);
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`signup:pickdrop:${lineupId}`)
    .setPlaceholder('Which character to drop?')
    .addOptions(myInLineup.map(lp => ({ label: lp.player_name, value: lp.player_name })));

  await interaction.reply({
    content: 'Which character do you want to drop?',
    components: [new ActionRowBuilder().addComponents(select)],
    ephemeral: true,
  });
}

async function handlePickDrop(interaction, lineupId, client) {
  const playerName = interaction.values[0];
  await deleteLineupPlayerByName(lineupId, playerName);
  await respondTo(interaction, {
    content: `🚪 Removed **${playerName}** from the lineup.`,
    components: [],
  });
  await refreshThread(client, lineupId);
}

module.exports = { handle };

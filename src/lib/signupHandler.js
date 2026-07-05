const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const crypto = require('crypto');
const supabase = require('../supabase');
const { wouldConflict } = require('./accountConflicts');
const { updateRaidThread } = require('./updateRaidThread');
const { getFamilyOptions, getSpecOptions, getFinalClassOptions, CLASS_FAMILIES } = require('./classData');
const { getClassEmojiTag } = require('./classEmojis');
const {
  ALL_COMPLETION_COLUMNS,
  getLineupSize,
  isCharacterEligible,
  usesTickets,
} = require('./raidTypes');

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
  const baseColumns = ['id', 'name', 'role', 'discord_id', 'account_number', 'exclude', 'exclude_label', 'classic_ticket_used'];
  const select = [...baseColumns, ...ALL_COMPLETION_COLUMNS].join(', ');
  const { data, error } = await supabase
    .from('players')
    .select(select)
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
  const lineupSize = getLineupSize(lineup.raid_type);
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
  // Modal submit triggered from a message component can update that message —
  // we use this to dismiss the Yes/No prompt the moment the name modal submits.
  if (interaction.isModalSubmit() && interaction.message) return true;
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
      if (action === 'join')      return void await handleJoinClick(interaction, parts[2]);
      if (action === 'drop')      return void await handleDropClick(interaction, parts[2], client);
      if (action === 'approve')   return void await handleApproveClick(interaction, parts[2], client);
      if (action === 'deny')      return void await handleDenyClick(interaction, parts[2]);
      if (action === 'joinguest') return void await handleJoinGuestClick(interaction, parts[2]);
      if (action === 'cancel')    return void await handleCancelClick(interaction);
    }
    if (interaction.isStringSelectMenu()) {
      if (action === 'pickchar') return void await handlePickChar(interaction, parts[2]);
      if (action === 'pickdrop') return void await handlePickDrop(interaction, parts[2], client);
      if (action === 'ticket')   return void await handleTicketPick(interaction, parts[2], client);
      if (action === 'gclass')   return void await handleGuestClassPick(interaction, parts[2]);
      if (action === 'gsubclass')return void await handleGuestSubclassPick(interaction, parts[2]);
      if (action === 'gfinal')   return void await handleGuestFinalClassPick(interaction, parts[2]);
      if (action === 'guesttkt') return void await handleGuestTicketPick(interaction, parts[2]);
    }
    if (interaction.isModalSubmit()) {
      if (action === 'guestmodal') return void await handleGuestNameModalSubmit(interaction, parts[2]);
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
  const lineup = await getLineupWithPlayers(lineupId);
  // "Next Week" lineups (is_template) ignore this week's completion — those
  // clears reset before the lineup runs. Mirrors the web app's lineup editor
  // (isNextWeek ? true : playerNeedsRaid). Everyone's characters stay eligible.
  const eligible = lineup.is_template
    ? characters
    : characters.filter(c => isCharacterEligible(c, lineup.raid_type));

  // Nothing eligible → offer the unregistered/guest path with the right copy.
  if (eligible.length === 0) {
    const haveDoneChars = characters.length > 0;
    return await showUnregisteredPrompt(interaction, lineupId, haveDoneChars);
  }

  // Always show the picker when the user has any characters — gives them the
  // "Add a different character" escape hatch even when only 1 is eligible.
  return await showCharacterPicker(interaction, lineupId, eligible);
}

// === Unregistered / "joining on a different character" prompt ===

async function showUnregisteredPrompt(interaction, lineupId, haveDoneChars) {
  const yesBtn = new ButtonBuilder()
    .setCustomId(`signup:joinguest:${lineupId}`)
    .setLabel('Yes — joining on another character')
    .setStyle(ButtonStyle.Primary);
  const noBtn = new ButtonBuilder()
    .setCustomId(`signup:cancel`)
    .setLabel('No, never mind')
    .setStyle(ButtonStyle.Secondary);

  const intro = haveDoneChars
    ? 'Your registered characters are already done for the week.'
    : "You don't have a registered character.";

  await respondTo(interaction, {
    content: `${intro}\n\nAre you joining on a character not registered?`,
    components: [new ActionRowBuilder().addComponents(yesBtn, noBtn)],
  });
}

async function handleCancelClick(interaction) {
  await respondTo(interaction, { content: 'Okay — no action taken.', components: [] });
}

// Yes button → open a modal asking for the character name.
async function handleJoinGuestClick(interaction, lineupId) {
  const modal = new ModalBuilder()
    .setCustomId(`signup:guestmodal:${lineupId}`)
    .setTitle('Character name');

  const nameInput = new TextInputBuilder()
    .setCustomId('charname')
    .setLabel('What\'s the character name?')
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(32)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
  await interaction.showModal(modal);
}

async function handleGuestNameModalSubmit(interaction, lineupId) {
  const characterName = interaction.fields.getTextInputValue('charname').trim();
  if (!characterName) {
    return await interaction.reply({ content: 'Character name is required.', ephemeral: true });
  }

  // Stash the in-progress guest application — class picks update this.
  const requestId = makeRequestId();
  setStash(requestId, {
    lineupId,
    discordId: interaction.user.id,
    characterName,
    familyKey: null,
    specKey: null,
    finalClass: null,
    usesTicket: false,
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`signup:gclass:${requestId}`)
    .setPlaceholder('Pick your class family')
    .addOptions(getFamilyOptions());

  // respondTo will call update() on the Yes/No ephemeral, replacing it
  // in-place with the class picker — old buttons gone, no double-submit.
  await respondTo(interaction, {
    content: `**${characterName}** — Step 1 of 3: class family`,
    components: [new ActionRowBuilder().addComponents(select)],
  });
}

function ensureRequestOwner(stashData, interaction) {
  if (!stashData) return 'expired';
  if (stashData.discordId !== interaction.user.id) return 'wrong-user';
  return 'ok';
}

async function handleGuestClassPick(interaction, requestId) {
  const data = stash.get(requestId);
  const status = ensureRequestOwner(data, interaction);
  if (status === 'expired') return await respondTo(interaction, { content: 'This prompt expired. Click Join again.', components: [] });
  if (status === 'wrong-user') return await interaction.reply({ content: "That prompt isn't for you.", ephemeral: true });

  const familyKey = interaction.values[0];
  const fam = CLASS_FAMILIES[familyKey];
  if (!fam) return await respondTo(interaction, { content: 'Unknown class family.', components: [] });

  data.familyKey = familyKey;

  const select = new StringSelectMenuBuilder()
    .setCustomId(`signup:gsubclass:${requestId}`)
    .setPlaceholder('Pick your specialization')
    .addOptions(getSpecOptions(familyKey));

  await respondTo(interaction, {
    content: `**${data.characterName}** — Step 2 of 3: ${fam.name} → specialization`,
    components: [new ActionRowBuilder().addComponents(select)],
  });
}

async function handleGuestSubclassPick(interaction, requestId) {
  const data = stash.get(requestId);
  const status = ensureRequestOwner(data, interaction);
  if (status === 'expired') return await respondTo(interaction, { content: 'This prompt expired. Click Join again.', components: [] });
  if (status === 'wrong-user') return await interaction.reply({ content: "That prompt isn't for you.", ephemeral: true });

  const specKey = interaction.values[0];
  const spec = CLASS_FAMILIES[data.familyKey]?.specializations?.[specKey];
  if (!spec) return await respondTo(interaction, { content: 'Unknown specialization.', components: [] });

  data.specKey = specKey;

  const select = new StringSelectMenuBuilder()
    .setCustomId(`signup:gfinal:${requestId}`)
    .setPlaceholder('Pick your final class')
    .addOptions(getFinalClassOptions(data.familyKey, specKey));

  await respondTo(interaction, {
    content: `**${data.characterName}** — Step 3 of 3: ${spec.name} → final class`,
    components: [new ActionRowBuilder().addComponents(select)],
  });
}

async function handleGuestFinalClassPick(interaction, requestId) {
  const data = stash.get(requestId);
  const status = ensureRequestOwner(data, interaction);
  if (status === 'expired') return await respondTo(interaction, { content: 'This prompt expired. Click Join again.', components: [] });
  if (status === 'wrong-user') return await interaction.reply({ content: "That prompt isn't for you.", ephemeral: true });

  const finalClass = interaction.values[0];
  const valid = getFinalClassOptions(data.familyKey, data.specKey).map(o => o.value);
  if (!valid.includes(finalClass)) return await respondTo(interaction, { content: 'Unknown class.', components: [] });

  data.finalClass = finalClass;

  const lineup = await getLineupWithPlayers(data.lineupId);
  if (usesTickets(lineup.raid_type)) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`signup:guesttkt:${requestId}`)
      .setPlaceholder('Pania ticket?')
      .addOptions(
        { label: 'Yes', value: 'yes', description: 'Use a Pania ticket for this clear' },
        { label: 'No', value: 'no' },
      );
    return await respondTo(interaction, {
      content: `**${data.characterName}** (${finalClass}) — Pania ticket?`,
      components: [new ActionRowBuilder().addComponents(select)],
    });
  }
  return await submitGuestApproval(interaction, requestId);
}

async function handleGuestTicketPick(interaction, requestId) {
  const data = stash.get(requestId);
  const status = ensureRequestOwner(data, interaction);
  if (status === 'expired') return await respondTo(interaction, { content: 'This prompt expired. Click Join again.', components: [] });
  if (status === 'wrong-user') return await interaction.reply({ content: "That prompt isn't for you.", ephemeral: true });

  data.usesTicket = interaction.values[0] === 'yes';
  return await submitGuestApproval(interaction, requestId);
}

async function submitGuestApproval(interaction, requestId) {
  const data = stash.get(requestId);
  if (!data) return await respondTo(interaction, { content: 'This prompt expired. Click Join again.', components: [] });
  stash.delete(requestId);
  return await postApprovalRequest(interaction, data.lineupId, /*character*/ null, data.usesTicket, 'unregistered character', {
    guest: { name: data.characterName, finalClass: data.finalClass },
  });
}

// Sentinel value used in the character picker for "use a different character"
const GUEST_OPTION_VALUE = '__guest__';

async function showCharacterPicker(interaction, lineupId, characters) {
  const options = characters.slice(0, 24).map(c => {
    const opt = { label: c.name, value: c.name };
    const bits = [];
    if (c.account_number) bits.push(`Account ${c.account_number}`);
    if (c.exclude) bits.push('excluded');
    if (bits.length > 0) opt.description = bits.join(' · ');
    return opt;
  });
  options.push({
    label: 'Sign up on a new character',
    value: GUEST_OPTION_VALUE,
    emoji: '➕',
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
  const value = interaction.values[0];

  // "Add a different character" → open the guest name modal. Modal submit
  // will update() this ephemeral in place so the picker disappears.
  if (value === GUEST_OPTION_VALUE) {
    const modal = new ModalBuilder()
      .setCustomId(`signup:guestmodal:${lineupId}`)
      .setTitle('Character name');
    const nameInput = new TextInputBuilder()
      .setCustomId('charname')
      .setLabel('What\'s the character name?')
      .setStyle(TextInputStyle.Short)
      .setMinLength(1)
      .setMaxLength(32)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
    return await interaction.showModal(modal);
  }

  const characters = await getCharactersOwnedBy(interaction.user.id);
  const character = characters.find(c => c.name === value);
  if (!character) {
    return await respondTo(interaction, { content: 'Character not found.', components: [] });
  }
  return await proceedAfterChar(interaction, lineupId, character);
}

async function proceedAfterChar(interaction, lineupId, character) {
  const lineup = await getLineupWithPlayers(lineupId);
  if (usesTickets(lineup.raid_type)) {
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

  // Decide: auto-add or send for approval. Track gates separately from
  // displayed reasons — exclude triggers approval but isn't shown (the label
  // alone often isn't enough context, so we'd rather list nothing).
  const gates = [];
  const displayReasons = [];

  if (!appUser || (appUser.role !== 'guildmate' && appUser.role !== 'admin')) {
    gates.push('non-guildmate');
    displayReasons.push('not a guildmate');
  }
  if (appUser?.exclude) {
    gates.push('user-excluded');
  }
  if (character.exclude) {
    gates.push('character-excluded');
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
    gates.push('account-conflict');
    displayReasons.push(`same-account conflict with ${conflict.withName}`);
  }

  if (gates.length > 0) {
    return await postApprovalRequest(
      interaction,
      lineup.id,
      character,
      usesTicket,
      displayReasons.length > 0 ? displayReasons.join('; ') : null,
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

async function postApprovalRequest(interaction, lineupId, character, usesTicket, reason, opts = {}) {
  const guest = opts.guest || null;
  const requestId = makeRequestId();
  setStash(requestId, {
    lineupId,
    playerName: character?.name || null,
    playerId: character?.id || null,
    usesTicket: !!usesTicket,
    requesterId: interaction.user.id,
    guest, // { name, finalClass } or null
  });

  const approveBtn = new ButtonBuilder()
    .setCustomId(`signup:approve:${requestId}`)
    .setLabel('Approve')
    .setStyle(ButtonStyle.Success);
  const denyBtn = new ButtonBuilder()
    .setCustomId(`signup:deny:${requestId}`)
    .setLabel('Deny')
    .setStyle(ButtonStyle.Danger);

  let charLine;
  if (character) {
    const emoji = getClassEmojiTag(character.role);
    const classBit = character.role ? ` ${emoji ? emoji + ' ' : ''}${character.role}` : '';
    charLine = `Character: **${character.name}**${classBit}${usesTicket ? ' — Pania ticket 🎟️' : ''}`;
  } else if (guest) {
    const emoji = getClassEmojiTag(guest.finalClass);
    charLine = `Guest: **${guest.name}** ${emoji ? emoji + ' ' : ''}${guest.finalClass}${usesTicket ? ' — Pania ticket 🎟️' : ''}`;
  } else {
    charLine = 'Character: _none registered_';
  }

  const lines = [
    `🛂 **Applying to join party** — <@${interaction.user.id}>`,
    charLine,
  ];
  if (reason) lines.push(`Reason: ${reason}`);
  const content = lines.join('\n');

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
  if (!adminUser || (adminUser.role !== 'admin' && adminUser.role !== 'editor')) {
    return await interaction.reply({ content: 'Only admins or editors can approve sign-ups.', ephemeral: true });
  }

  const data = stash.get(requestId);
  if (!data) {
    return await interaction.reply({
      content: 'This request has expired or was already handled.',
      ephemeral: true,
    });
  }

  // Determine what we're inserting: a registered character row or a guest.
  const lineup = await getLineupWithPlayers(data.lineupId);
  const slot = nextEmptySlot(lineup);
  if (slot === null) {
    return await respondTo(interaction, {
      content: `${interaction.message.content}\n\n⚠️ **Lineup is full** — cannot add.`,
      components: [],
    });
  }

  let insertedAs;
  if (data.guest) {
    // Guest format mirrors the web app: [PUB]Name|Class
    const playerName = `[PUB]${data.guest.name}|${data.guest.finalClass}`;
    await insertLineupPlayer(data.lineupId, slot, playerName, null, data.usesTicket);
    insertedAs = `${data.guest.name} (${data.guest.finalClass}, guest)`;
  } else if (data.playerName && data.playerId) {
    const already = (lineup.lineup_players || []).some(lp => lp.player_name === data.playerName);
    if (already) {
      stash.delete(requestId);
      return await respondTo(interaction, {
        content: `${interaction.message.content}\n\n⚠️ **Already in lineup** — no action taken.`,
        components: [],
      });
    }
    await insertLineupPlayer(data.lineupId, slot, data.playerName, data.playerId, data.usesTicket);
    insertedAs = data.playerName;
  } else {
    stash.delete(requestId);
    return await respondTo(interaction, {
      content: `${interaction.message.content}\n\n❌ **Cannot approve** — request has no character or guest info.`,
      components: [],
    });
  }

  stash.delete(requestId);
  await respondTo(interaction, {
    content: `${interaction.message.content}\n\n✅ **Approved by <@${interaction.user.id}>** — added **${insertedAs}** to slot ${slot}.`,
    components: [],
  });
  await refreshThread(client, data.lineupId);
}

async function handleDenyClick(interaction, requestId) {
  const adminUser = await getAppUser(interaction.user.id);
  if (!adminUser || (adminUser.role !== 'admin' && adminUser.role !== 'editor')) {
    return await interaction.reply({ content: 'Only admins or editors can deny sign-ups.', ephemeral: true });
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

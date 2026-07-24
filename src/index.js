const { Client, Collection, GatewayIntentBits, Partials } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config();
const { startThreadRequestHandler } = require('./lib/threadRequestHandler');
const { startReminderScheduler } = require('./lib/reminderScheduler');
const { startRaidRoleScheduler } = require('./lib/raidRoleScheduler');
const { startNewUserNotifier, handleNewUserButton } = require('./lib/newUserNotifier');
const { startNewCharacterNotifier, handleNewCharacterButton } = require('./lib/newCharacterNotifier');
const { startLootSync } = require('./lib/lootThread');
const { startPayoutSync, startLootCloseSweeper } = require('./lib/lootPayout');
const { startLootClaimReminders } = require('./lib/lootClaimReminders');
const signupHandler = require('./lib/signupHandler');

// Global safety nets — a thrown error in one event/handler must NEVER take the
// whole bot down. On Node 15+ an unhandled promise rejection terminates the
// process by default, which is how a single bad event (e.g. a screenshot that
// errored mid-processing) was killing the bot. Log and keep running.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    // Gold-share ✅ confirmations in loot threads (non-privileged intent).
    GatewayIntentBits.GuildMessageReactions,
  ],
  // Reactions can land on messages the bot hasn't cached — receive them as
  // partials so MessageReactionAdd/Remove still fire (hydrated in the handler).
  partials: [Partials.Message, Partials.Reaction, Partials.Channel],
});

// Load commands
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  client.commands.set(command.data.name, command);
}

// Load events
const eventsPath = path.join(__dirname, 'events');
if (fs.existsSync(eventsPath)) {
  const eventFiles = fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'));
  for (const file of eventFiles) {
    const event = require(path.join(eventsPath, file));
    // Wrap every event handler so one throwing handler can't crash the bot
    // (mirrors the try/catch around command execution below).
    client.on(event.name, async (...args) => {
      try {
        await event.execute(...args);
      } catch (err) {
        console.error(`[event:${event.name}] handler error:`, err);
      }
    });
  }
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  startThreadRequestHandler(client);
  startReminderScheduler(client);
  startRaidRoleScheduler(client);
  startNewUserNotifier(client);
  startNewCharacterNotifier(client);
  startLootSync(client);
  startPayoutSync(client);
  startLootCloseSweeper(client);
  startLootClaimReminders(client);
});

client.on('interactionCreate', async (interaction) => {
  // Lineup sign-up: buttons, select menus, and the guest-name modal
  if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
    if (interaction.customId?.startsWith('signup:')) {
      await signupHandler.handle(interaction, client);
    } else if (interaction.customId?.startsWith('newuser:')) {
      await handleNewUserButton(interaction);
    } else if (interaction.customId?.startsWith('newchar:')) {
      await handleNewCharacterButton(interaction);
    } else if (interaction.customId?.startsWith('reactorthread:')) {
      await client.commands.get('Create thread with reactions').handleModal(interaction);
    }
    return;
  }

  // Autocomplete: route to the command's autocomplete handler if it has one
  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (!command?.autocomplete) return;
    try {
      await command.autocomplete(interaction);
    } catch (error) {
      console.error(`Autocomplete error in ${interaction.commandName}:`, error);
    }
    return;
  }

  if (!interaction.isChatInputCommand() && !interaction.isMessageContextMenuCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`Error executing ${interaction.commandName}:`, error);
    const reply = { content: 'Something went wrong running that command.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);

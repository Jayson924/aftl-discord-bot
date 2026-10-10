// Owner-only Claude agent that administers the Discord server through the tools below.
// Delete tools confirm with buttons inside run(), so the model can't skip confirmation.

const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { betaTool } = require('@anthropic-ai/sdk/helpers/beta/json-schema');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  OverwriteType,
  PermissionFlagsBits,
} = require('discord.js');
const supabase = require('../supabase');

const MODEL = process.env.ADMIN_AGENT_MODEL || 'claude-opus-5-5';
const MAX_HISTORY_MESSAGES = 60;
const CONFIRM_TIMEOUT_MS = 60_000;

const SUPABASE_TABLES = new Set(['players', 'lineups', 'lineup_players', 'app_users', 'app_config']);
const SUPABASE_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is']);

const CHANNEL_TYPES = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  stage: ChannelType.GuildStageVoice,
};
const CHANNEL_TYPE_NAMES = Object.fromEntries(Object.entries(CHANNEL_TYPES).map(([k, v]) => [v, k]));

const SYSTEM_PROMPT = `You are the server administrator assistant for this guild's Discord server. You act through the tools provided, on behalf of the server owner, who is the only person who can talk to you.

About the server:
- The guild plays several games. Do not assume every channel or role belongs to one game.
- Dragon Nest raids use these short names for channels, forum tags and roles: GDN HC (GDN Hardcore), GDN C (GDN Classic), DDN HC (DDN Hardcore), DDN C (DDN Classic), BDN C (BDN Classic).
- The bot's own configuration (forum tag IDs, role IDs, channel IDs) lives in its .env file on the server. You cannot edit it. When you create something the bot should know about, report the ID and the env var it likely belongs in (e.g. RAID_TAG_BDN_C, RAID_ROLE_BDN_CLASSIC) so the owner can paste it in.

How to work:
- Look before you change: use the list tools to find exact IDs instead of guessing.
- If a request would change more than about three things, list the planned changes first and wait for the owner to say go.
- Prefer editing an existing channel or role over deleting and recreating it.
- Delete tools ask the owner to confirm with a button. If the result says cancelled or timed out, stop and say so; do not retry.
- When you finish, give a short summary of what changed, with names and IDs. Discord shows your reply as a chat message, so keep it brief and use plain Discord markdown.`;

let anthropic;
function getClient() {
  if (!anthropic) anthropic = new Anthropic();
  return anthropic;
}

// channelId → messages[]. Restarted rather than trimmed when long: editing
// earlier turns invalidates the model's thinking blocks.
const conversations = new Map();

function resetConversation(channelId) {
  conversations.delete(channelId);
}

async function getGuild(client) {
  return client.guilds.cache.get(process.env.GUILD_ID) || client.guilds.fetch(process.env.GUILD_ID);
}

function need(input, ...keys) {
  for (const k of keys) {
    if (input[k] === undefined || input[k] === null || input[k] === '') {
      throw new Error(`Missing required field "${k}"`);
    }
  }
}

function humanize(flag) {
  return flag.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

function toPermissionFlags(names = []) {
  return names.map((name) => {
    const key = String(name).replace(/\s+/g, '');
    if (!(key in PermissionFlagsBits)) throw new Error(`Unknown permission "${name}"`);
    return key;
  });
}

function parseColor(color) {
  if (color == null || color === '') return undefined;
  const hex = String(color).replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`Color must be a hex value like #5b3a8c, got "${color}"`);
  return parseInt(hex, 16);
}

function describeChannel(ch) {
  return {
    id: ch.id,
    name: ch.name,
    type: CHANNEL_TYPE_NAMES[ch.type] || `type ${ch.type}`,
    parentId: ch.parentId || null,
    position: ch.rawPosition ?? ch.position,
    ...(ch.availableTags ? { tags: ch.availableTags.map((t) => ({ id: t.id, name: t.name })) } : {}),
  };
}

// Builds the tool set for one run. Tools close over the triggering message so
// confirmation prompts and audit lines go to the right place.
function buildTools({ message }) {
  const client = message.client;

  async function audit(tool, input, result) {
    const line = `[admin-agent] ${message.author.tag} → ${tool} ${JSON.stringify(input)} → ${result}`;
    console.log(line);
    const logChannelId = process.env.ADMIN_AGENT_LOG_CHANNEL_ID;
    if (!logChannelId) return;
    try {
      const ch = await client.channels.fetch(logChannelId);
      await ch?.send({ content: line.slice(0, 1900), allowedMentions: { parse: [] } });
    } catch (err) {
      console.error('[admin-agent] audit log send failed:', err.message);
    }
  }

  // Confirm/Cancel buttons from the owner, enforced here rather than by prompt.
  async function confirm(description) {
    const nonce = crypto.randomBytes(6).toString('hex');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`adminconfirm:${nonce}:yes`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`adminconfirm:${nonce}:no`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    const embed = new EmbedBuilder().setColor(0xc0392b).setTitle('Confirm action').setDescription(description);
    const prompt = await message.channel.send({ embeds: [embed], components: [row] });
    try {
      const interaction = await prompt.awaitMessageComponent({
        filter: (i) => i.customId.startsWith(`adminconfirm:${nonce}:`) && i.user.id === process.env.OWNER_ID,
        time: CONFIRM_TIMEOUT_MS,
      });
      const ok = interaction.customId.endsWith(':yes');
      await interaction.update({
        embeds: [embed.setTitle(ok ? 'Confirmed' : 'Cancelled').setColor(ok ? 0x27ae60 : 0x7f8c8d)],
        components: [],
      });
      return ok ? 'confirmed' : 'cancelled by user';
    } catch {
      await prompt.edit({ embeds: [embed.setTitle('Timed out').setColor(0x7f8c8d)], components: [] }).catch(() => {});
      return 'timed out';
    }
  }

  // Wraps a mutating tool's run so every call is audited, success or failure.
  function audited(name, run) {
    return async (input) => {
      try {
        const result = await run(input);
        await audit(name, input, typeof result === 'string' ? result : JSON.stringify(result));
        return typeof result === 'string' ? result : JSON.stringify(result);
      } catch (err) {
        await audit(name, input, `ERROR ${err.message}`);
        throw err;
      }
    };
  }

  return [
    // ---------- read-only ----------
    betaTool({
      name: 'list_channels',
      description: 'List every channel in the server with id, name, type, parent category id and position. Forum channels include their tags.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const guild = await getGuild(client);
        const channels = await guild.channels.fetch();
        return JSON.stringify([...channels.values()].filter(Boolean).map(describeChannel));
      },
    }),
    betaTool({
      name: 'list_roles',
      description: 'List every role with id, name, hex color, position and member count.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const guild = await getGuild(client);
        await guild.members.fetch();
        const roles = await guild.roles.fetch();
        return JSON.stringify([...roles.values()]
          .sort((a, b) => b.position - a.position)
          .map((r) => ({ id: r.id, name: r.name, color: r.hexColor, position: r.position, memberCount: r.members.size, managed: r.managed })));
      },
    }),
    betaTool({
      name: 'get_channel_permissions',
      description: 'Show the permission overwrites on a channel: which roles/members are allowed or denied which permissions.',
      inputSchema: {
        type: 'object',
        properties: { channelId: { type: 'string' } },
        required: ['channelId'],
        additionalProperties: false,
      },
      run: async (input) => {
        need(input, 'channelId');
        const guild = await getGuild(client);
        const channel = await guild.channels.fetch(input.channelId);
        if (!channel) throw new Error('Channel not found');
        const overwrites = [...channel.permissionOverwrites.cache.values()].map((ow) => {
          const target = ow.type === OverwriteType.Role ? guild.roles.cache.get(ow.id)?.name : guild.members.cache.get(ow.id)?.user.tag;
          return {
            targetId: ow.id,
            targetType: ow.type === OverwriteType.Role ? 'role' : 'member',
            target: target || ow.id,
            allow: ow.allow.toArray().map(humanize),
            deny: ow.deny.toArray().map(humanize),
          };
        });
        return JSON.stringify({ channel: channel.name, synced: channel.permissionsLocked ?? null, overwrites });
      },
    }),
    betaTool({
      name: 'list_members',
      description: 'List up to 100 server members (id, username, display name), optionally only those with a given role.',
      inputSchema: {
        type: 'object',
        properties: { roleId: { type: 'string', description: 'Only members with this role' } },
        additionalProperties: false,
      },
      run: async (input) => {
        const guild = await getGuild(client);
        const members = await guild.members.fetch();
        const list = [...members.values()]
          .filter((m) => !input.roleId || m.roles.cache.has(input.roleId))
          .slice(0, 100)
          .map((m) => ({ id: m.id, username: m.user.username, displayName: m.displayName, bot: m.user.bot }));
        return JSON.stringify(list);
      },
    }),
    betaTool({
      name: 'query_supabase',
      description: `Read rows from the raid app database (read-only). Tables: ${[...SUPABASE_TABLES].join(', ')}. Returns at most 50 rows.`,
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', enum: [...SUPABASE_TABLES] },
          select: { type: 'string', description: 'Columns, PostgREST syntax. Default "*".' },
          filters: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                column: { type: 'string' },
                op: { type: 'string', enum: [...SUPABASE_OPS] },
                value: { type: ['string', 'number', 'boolean', 'null'] },
              },
              required: ['column', 'op', 'value'],
              additionalProperties: false,
            },
          },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: ['table'],
        additionalProperties: false,
      },
      run: async (input) => {
        need(input, 'table');
        if (!SUPABASE_TABLES.has(input.table)) throw new Error(`Table "${input.table}" is not allowed`);
        let query = supabase.from(input.table).select(input.select || '*');
        for (const f of input.filters || []) {
          if (!SUPABASE_OPS.has(f.op)) throw new Error(`Operator "${f.op}" is not allowed`);
          query = query[f.op](f.column, f.value);
        }
        const { data, error } = await query.limit(Math.min(Math.max(input.limit || 50, 1), 50));
        if (error) throw new Error(error.message);
        return JSON.stringify(data);
      },
    }),

    // ---------- mutating, non-destructive ----------
    betaTool({
      name: 'create_channel',
      description: 'Create a channel. Returns its id.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: Object.keys(CHANNEL_TYPES) },
          parentId: { type: 'string', description: 'Category id to create it under' },
          topic: { type: 'string' },
        },
        required: ['name', 'type'],
        additionalProperties: false,
      },
      run: audited('create_channel', async (input) => {
        need(input, 'name', 'type');
        const guild = await getGuild(client);
        const channel = await guild.channels.create({
          name: input.name,
          type: CHANNEL_TYPES[input.type],
          parent: input.parentId || undefined,
          topic: input.topic || undefined,
          reason: `Admin agent, requested by ${message.author.tag}`,
        });
        return describeChannel(channel);
      }),
    }),
    betaTool({
      name: 'edit_channel',
      description: 'Rename a channel, change its topic, move it to another category, or change its position. Only the fields given are changed. Set parentId to null to remove it from its category.',
      inputSchema: {
        type: 'object',
        properties: {
          channelId: { type: 'string' },
          name: { type: 'string' },
          topic: { type: 'string' },
          parentId: { type: ['string', 'null'] },
          lockPermissions: { type: 'boolean', description: 'When moving, sync permissions with the new category' },
          position: { type: 'integer' },
        },
        required: ['channelId'],
        additionalProperties: false,
      },
      run: audited('edit_channel', async (input) => {
        need(input, 'channelId');
        const guild = await getGuild(client);
        const channel = await guild.channels.fetch(input.channelId);
        if (!channel) throw new Error('Channel not found');
        const edit = {};
        if (input.name !== undefined) edit.name = input.name;
        if (input.topic !== undefined) edit.topic = input.topic;
        if (input.parentId !== undefined) edit.parent = input.parentId;
        if (input.lockPermissions !== undefined) edit.lockPermissions = input.lockPermissions;
        if (input.position !== undefined) edit.position = input.position;
        const updated = await channel.edit({ ...edit, reason: `Admin agent, requested by ${message.author.tag}` });
        return describeChannel(updated);
      }),
    }),
    betaTool({
      name: 'set_channel_permission',
      description: 'Set a permission overwrite for a role or member on a channel. Permission names are Discord flag names like ViewChannel, SendMessages, ManageMessages. "reset" puts a permission back to inherit.',
      inputSchema: {
        type: 'object',
        properties: {
          channelId: { type: 'string' },
          targetId: { type: 'string', description: 'Role or member id. The @everyone role id equals the server id.' },
          allow: { type: 'array', items: { type: 'string' } },
          deny: { type: 'array', items: { type: 'string' } },
          reset: { type: 'array', items: { type: 'string' } },
        },
        required: ['channelId', 'targetId'],
        additionalProperties: false,
      },
      run: audited('set_channel_permission', async (input) => {
        need(input, 'channelId', 'targetId');
        const guild = await getGuild(client);
        const channel = await guild.channels.fetch(input.channelId);
        if (!channel) throw new Error('Channel not found');
        const overwrite = {};
        for (const f of toPermissionFlags(input.allow)) overwrite[f] = true;
        for (const f of toPermissionFlags(input.deny)) overwrite[f] = false;
        for (const f of toPermissionFlags(input.reset)) overwrite[f] = null;
        if (Object.keys(overwrite).length === 0) throw new Error('Nothing to change: give allow, deny or reset');
        await channel.permissionOverwrites.edit(input.targetId, overwrite, {
          reason: `Admin agent, requested by ${message.author.tag}`,
        });
        return `Updated permissions for ${input.targetId} on #${channel.name}`;
      }),
    }),
    betaTool({
      name: 'create_role',
      description: 'Create a role. Returns its id.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          color: { type: 'string', description: 'Hex color like #5b3a8c' },
          hoist: { type: 'boolean', description: 'Show members separately in the member list' },
          mentionable: { type: 'boolean' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      run: audited('create_role', async (input) => {
        need(input, 'name');
        const guild = await getGuild(client);
        const role = await guild.roles.create({
          name: input.name,
          color: parseColor(input.color),
          hoist: input.hoist ?? false,
          mentionable: input.mentionable ?? false,
          reason: `Admin agent, requested by ${message.author.tag}`,
        });
        return { id: role.id, name: role.name, color: role.hexColor };
      }),
    }),
    betaTool({
      name: 'edit_role',
      description: 'Change a role\'s name, color, hoist, mentionable flag or position. Only the fields given are changed.',
      inputSchema: {
        type: 'object',
        properties: {
          roleId: { type: 'string' },
          name: { type: 'string' },
          color: { type: 'string' },
          hoist: { type: 'boolean' },
          mentionable: { type: 'boolean' },
          position: { type: 'integer' },
        },
        required: ['roleId'],
        additionalProperties: false,
      },
      run: audited('edit_role', async (input) => {
        need(input, 'roleId');
        const guild = await getGuild(client);
        const role = await guild.roles.fetch(input.roleId);
        if (!role) throw new Error('Role not found');
        const edit = {};
        if (input.name !== undefined) edit.name = input.name;
        if (input.color !== undefined) edit.color = parseColor(input.color);
        if (input.hoist !== undefined) edit.hoist = input.hoist;
        if (input.mentionable !== undefined) edit.mentionable = input.mentionable;
        if (input.position !== undefined) edit.position = input.position;
        const updated = await role.edit({ ...edit, reason: `Admin agent, requested by ${message.author.tag}` });
        return { id: updated.id, name: updated.name, color: updated.hexColor, position: updated.position };
      }),
    }),
    betaTool({
      name: 'add_role_to_member',
      description: 'Give a role to a member.',
      inputSchema: {
        type: 'object',
        properties: { memberId: { type: 'string' }, roleId: { type: 'string' } },
        required: ['memberId', 'roleId'],
        additionalProperties: false,
      },
      run: audited('add_role_to_member', async (input) => {
        need(input, 'memberId', 'roleId');
        const guild = await getGuild(client);
        const member = await guild.members.fetch(input.memberId);
        await member.roles.add(input.roleId, `Admin agent, requested by ${message.author.tag}`);
        return `Added role ${input.roleId} to ${member.user.tag}`;
      }),
    }),
    betaTool({
      name: 'remove_role_from_member',
      description: 'Take a role away from a member.',
      inputSchema: {
        type: 'object',
        properties: { memberId: { type: 'string' }, roleId: { type: 'string' } },
        required: ['memberId', 'roleId'],
        additionalProperties: false,
      },
      run: audited('remove_role_from_member', async (input) => {
        need(input, 'memberId', 'roleId');
        const guild = await getGuild(client);
        const member = await guild.members.fetch(input.memberId);
        await member.roles.remove(input.roleId, `Admin agent, requested by ${message.author.tag}`);
        return `Removed role ${input.roleId} from ${member.user.tag}`;
      }),
    }),
    betaTool({
      name: 'create_forum_tag',
      description: 'Add a tag to a forum channel. Returns the new tag id.',
      inputSchema: {
        type: 'object',
        properties: {
          channelId: { type: 'string' },
          name: { type: 'string' },
          emoji: { type: 'string', description: 'A unicode emoji, optional' },
        },
        required: ['channelId', 'name'],
        additionalProperties: false,
      },
      run: audited('create_forum_tag', async (input) => {
        need(input, 'channelId', 'name');
        const guild = await getGuild(client);
        const channel = await guild.channels.fetch(input.channelId);
        if (!channel || channel.type !== ChannelType.GuildForum) throw new Error('Not a forum channel');
        if (channel.availableTags.some((t) => t.name.toLowerCase() === input.name.toLowerCase())) {
          throw new Error(`Tag "${input.name}" already exists`);
        }
        const updated = await channel.setAvailableTags(
          [...channel.availableTags, { name: input.name, emoji: input.emoji ? { id: null, name: input.emoji } : null }],
          `Admin agent, requested by ${message.author.tag}`,
        );
        const tag = updated.availableTags.find((t) => t.name === input.name);
        return { id: tag?.id, name: input.name, channel: channel.name };
      }),
    }),
    betaTool({
      name: 'send_message',
      description: 'Post a message in a channel as the bot.',
      inputSchema: {
        type: 'object',
        properties: { channelId: { type: 'string' }, text: { type: 'string', maxLength: 2000 } },
        required: ['channelId', 'text'],
        additionalProperties: false,
      },
      run: audited('send_message', async (input) => {
        need(input, 'channelId', 'text');
        const channel = await client.channels.fetch(input.channelId);
        if (!channel?.isTextBased()) throw new Error('Not a text channel');
        const sent = await channel.send({ content: input.text.slice(0, 2000), allowedMentions: { parse: [] } });
        return `Sent message ${sent.id} in #${channel.name}`;
      }),
    }),

    // ---------- destructive (owner confirms with a button) ----------
    betaTool({
      name: 'delete_channel',
      description: 'Delete a channel. The owner is asked to confirm with a button first.',
      inputSchema: {
        type: 'object',
        properties: { channelId: { type: 'string' }, reason: { type: 'string' } },
        required: ['channelId'],
        additionalProperties: false,
      },
      run: audited('delete_channel', async (input) => {
        need(input, 'channelId');
        const guild = await getGuild(client);
        const channel = await guild.channels.fetch(input.channelId);
        if (!channel) throw new Error('Channel not found');
        const kind = CHANNEL_TYPE_NAMES[channel.type] || 'channel';
        const children = channel.type === ChannelType.GuildCategory
          ? guild.channels.cache.filter((c) => c.parentId === channel.id).size
          : 0;
        const answer = await confirm(
          `Delete ${kind} **${channel.name}** (\`${channel.id}\`)?` +
          (children ? `\nIts ${children} channel(s) will be left without a category.` : '') +
          (input.reason ? `\nReason: ${input.reason}` : ''),
        );
        if (answer !== 'confirmed') return answer;
        await channel.delete(`Admin agent, requested by ${message.author.tag}`);
        return `Deleted ${kind} ${channel.name} (${channel.id})`;
      }),
    }),
    betaTool({
      name: 'delete_role',
      description: 'Delete a role. The owner is asked to confirm with a button first.',
      inputSchema: {
        type: 'object',
        properties: { roleId: { type: 'string' }, reason: { type: 'string' } },
        required: ['roleId'],
        additionalProperties: false,
      },
      run: audited('delete_role', async (input) => {
        need(input, 'roleId');
        const guild = await getGuild(client);
        await guild.members.fetch();
        const role = await guild.roles.fetch(input.roleId);
        if (!role) throw new Error('Role not found');
        const answer = await confirm(
          `Delete role **${role.name}** (\`${role.id}\`), held by ${role.members.size} member(s)?` +
          (input.reason ? `\nReason: ${input.reason}` : ''),
        );
        if (answer !== 'confirmed') return answer;
        await role.delete(`Admin agent, requested by ${message.author.tag}`);
        return `Deleted role ${role.name} (${role.id})`;
      }),
    }),
  ];
}

function finalText(msg) {
  return (msg.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// Runs one owner request through the agent and returns the reply text.
async function runAdminAgent({ message, text }) {
  const channelId = message.channel.id;
  let history = conversations.get(channelId) || [];
  let restarted = false;
  if (history.length > MAX_HISTORY_MESSAGES) {
    history = [];
    restarted = true;
  }

  const runner = getClient().beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    max_iterations: 25,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    cache_control: { type: 'ephemeral' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM_PROMPT,
    tools: buildTools({ message }),
    messages: [...history, { role: 'user', content: text }],
  });

  const final = await runner.runUntilDone();
  // Save the whole exchange, tool calls included, so the next turn has context.
  conversations.set(channelId, [...runner.params.messages]);

  let reply;
  if (final.stop_reason === 'refusal') {
    const category = final.stop_details?.category;
    reply = `I can't help with that request${category ? ` (declined: ${category})` : ''}.`;
  } else {
    reply = finalText(final) || 'Done.';
    if (final.stop_reason === 'tool_use') {
      reply += '\n\n_Stopped after the step limit; ask me to continue if something is unfinished._';
    }
  }
  if (restarted) reply = `_(Earlier conversation cleared to keep context small.)_\n${reply}`;
  return reply;
}

module.exports = { runAdminAgent, resetConversation, MODEL };

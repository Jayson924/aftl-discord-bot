// Mark loot sold from a screenshot.
//
// When someone posts an image in a loot THREAD (a child of LOOT_CHANNEL_ID),
// the bot reads it with Claude Vision. If it's a Dragon Nest item-sale screenshot
// (a "Trading House Payment" mailbox message), it pulls the item + the gold the
// seller receives, matches it to a logged unsold loot item, and marks it sold —
// with the poster set as the holder. If it can't match, it asks the poster to
// record it manually with `/loot`.
//
// The existing loot-screenshot.js event only fires in the parent LOOT_CHANNEL_ID
// (creates lineups from party screenshots); this one only fires inside the loot
// threads, so they don't overlap.

const { Events } = require('discord.js');
const {
  fmtGold,
  resolveParentByThread,
  getLootRows,
  getRosterDisplay,
  updateLootEntry,
  updateLootMessage,
} = require('../lib/lootThread');

function detectMimeType(buffer, fallback) {
  const h = buffer.slice(0, 12);
  if (h[0] === 0x89 && h[1] === 0x50) return 'image/png';
  if (h[0] === 0xff && h[1] === 0xd8) return 'image/jpeg';
  if (h.toString('ascii', 0, 4) === 'RIFF' && h.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (h.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return fallback || 'image/png';
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Best local match of an extracted item name against unsold loot rows. Exact →
// substring → token-overlap (Jaccard ≥ 0.5). Returns a row or null.
function localMatch(extracted, candidates) {
  const e = norm(extracted);
  if (!e) return null;

  let m = candidates.find(c => norm(c.item) === e);
  if (m) return m;

  m = candidates.find(c => {
    const ci = norm(c.item);
    return ci && (ci.includes(e) || e.includes(ci));
  });
  if (m) return m;

  const eTokens = new Set(e.split(' ').filter(Boolean));
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    const cTokens = new Set(norm(c.item).split(' ').filter(Boolean));
    if (cTokens.size === 0) continue;
    const inter = [...eTokens].filter(t => cTokens.has(t)).length;
    const union = new Set([...eTokens, ...cTokens]).size;
    const score = union ? inter / union : 0;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= 0.5 ? best : null;
}

async function analyzeLootSale(buffer, mimeType, candidateItems) {
  const base64 = buffer.toString('base64');

  const candidateHint = candidateItems.length > 0
    ? `\n\nThese loot items are currently logged for this raid and still unsold. If the sold item matches one of them, set "matchedItem" to the EXACT string from this list; otherwise null:\n${candidateItems.map(i => `- ${i}`).join('\n')}`
    : '\n\nThere are no logged unsold items; set "matchedItem" to null.';

  const systemPrompt = `You analyze a Dragon Nest in-game screenshot to detect an ITEM SALE (typically a "Trading House Payment" mailbox / mail message). Extract what item was sold and how much gold the seller actually receives.

The mail usually reads like:
"Number of <ITEM NAME> sold : <count>. Commission (<X> Gold ...) has been deducted and you will get <N> Gold 0 Silver 0 Copper."

Return ONLY this JSON (no markdown, no code fences):
{
  "isSale": true | false,
  "item": "<the item name that was sold, e.g. the X in 'Number of X sold'>" | null,
  "gold": <integer — the NET gold the seller RECEIVES, i.e. the "you will get N Gold" amount>,
  "matchedItem": "<exact string from the candidate list this corresponds to, or null>",
  "notes": "<anything unclear>"
}

Rules:
- isSale is true ONLY if this is clearly an item-sale / trading-house payment screenshot. Otherwise isSale=false and the rest null/0.
- gold = the amount the seller GETS (the "you will get" value), NOT the commission and NOT the gross. Ignore silver/copper. No commas.
- item = just the item name.
- matchedItem must be EXACTLY one of the candidates or null.${candidateHint}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
            { type: 'text', text: 'Analyze this screenshot for an item sale. Return only the JSON.' },
          ],
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic API error: ${await res.text()}`);
  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonMatch ? jsonMatch[0] : text);
}

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    if (message.author.bot) return;
    if (!message.channel?.isThread?.()) return;
    // Only loot threads (children of the loot channel).
    if (process.env.LOOT_CHANNEL_ID && message.channel.parentId !== process.env.LOOT_CHANNEL_ID) return;

    const attachment = message.attachments.find(a => a.contentType?.startsWith('image/'));
    if (!attachment) return;

    // Must be a linked loot thread (live lineup or archived loot record).
    let parent;
    try {
      parent = await resolveParentByThread(message.channel.id);
    } catch (err) {
      console.error('[loot-sold-screenshot] parent lookup failed:', err.message);
      return;
    }
    if (!parent || parent.lootThreadId !== message.channel.id) return;

    await message.react('⏳').catch(() => {});
    try {
      const unsold = (await getLootRows(parent)).filter(l => !l.sold);

      const response = await fetch(attachment.url);
      const buffer = Buffer.from(await response.arrayBuffer());
      const mimeType = detectMimeType(buffer, attachment.contentType);

      const parsed = await analyzeLootSale(buffer, mimeType, unsold.map(l => l.item));
      await message.reactions.removeAll().catch(() => {});

      // Not a sale screenshot — stay quiet (avoid reacting to chatter/memes).
      if (!parsed?.isSale || !parsed.gold) return;

      const gold = Math.max(0, Math.round(Number(parsed.gold) || 0));

      // Resolve the item: trust the model's pick, else fuzzy-match locally.
      let row = parsed.matchedItem ? unsold.find(l => l.item === parsed.matchedItem) : null;
      if (!row) row = localMatch(parsed.item, unsold);

      if (!row) {
        const itemTxt = parsed.item ? `**${parsed.item}**` : 'that item';
        await message.reply(
          `🧾 Detected a sale of ${itemTxt} for 🪙 **${fmtGold(gold)}**, but I couldn't match it to a logged loot item.\n` +
          `Record it with \`/loot sold\` (pick the item), or \`/loot add\` first if it isn't logged yet.`
        );
        return;
      }

      // The poster is the seller → they become the holder.
      const rosterDisplay = await getRosterDisplay(parent);
      const sellerName = rosterDisplay.find(r => r.discordId === message.author.id)?.name
        || message.member?.displayName
        || message.author.username;

      await updateLootEntry(row.id, { sold: true, price: gold, heldBy: sellerName });
      await updateLootMessage(message.client, parent);
      await message.react('✅').catch(() => {});
      await message.reply(`💰 **${row.item}** marked sold for 🪙 **${fmtGold(gold)}** — held by **${sellerName}**.`);
    } catch (err) {
      console.error('[loot-sold-screenshot] error:', err.message);
      await message.reactions.removeAll().catch(() => {});
      await message.reply('Couldn\'t read that screenshot. Use `/loot sold` to record it manually.').catch(() => {});
    }
  },
};

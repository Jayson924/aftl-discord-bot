const { Events, ChannelType } = require('discord.js');
const supabase = require('../supabase');
const { clearLineup, getCompletedTag } = require('../lib/clearLineup');

// In-memory guard so the same thread can't be processed twice while the first
// run is still in flight (Discord can fire ThreadUpdate multiple times).
const inFlight = new Set();

module.exports = {
  name: Events.ThreadUpdate,
  async execute(oldThread, newThread) {
    // Make sure the parent channel is loaded — it may not be cached yet.
    let parent = newThread.parent;
    if (!parent) {
      try {
        parent = await newThread.client.channels.fetch(newThread.parentId);
      } catch (err) {
        console.error('[raid-tag-completed] failed to fetch parent channel:', err);
        return;
      }
    }
    if (!parent || parent.type !== ChannelType.GuildForum) return;

    const completedTag = getCompletedTag(parent);
    if (!completedTag) {
      console.log(`[raid-tag-completed] forum "${parent.name}" has no Cleared tag — skipping`);
      return;
    }

    const wasCompleted = (oldThread.appliedTags || []).includes(completedTag.id);
    const isCompleted = (newThread.appliedTags || []).includes(completedTag.id);

    // Only fire on the not-completed -> completed transition
    if (wasCompleted || !isCompleted) return;

    console.log(`[raid-tag-completed] Cleared tag applied to thread ${newThread.id} (${newThread.name})`);

    if (inFlight.has(newThread.id)) return;
    inFlight.add(newThread.id);

    try {
      const { data: lineup, error } = await supabase
        .from('lineups')
        .select('id, name, raid_type, raid_time, completed')
        .eq('thread_id', newThread.id)
        .limit(1)
        .single();

      if (error || !lineup) {
        console.log(`[raid-tag-completed] no lineup linked to thread ${newThread.id} — skipping`);
        return;
      }

      if (lineup.completed) {
        console.log(`[raid-tag-completed] lineup ${lineup.id} already completed — skipping`);
        return;
      }

      const result = await clearLineup({ lineup, raidThread: newThread, skipTag: true });

      if (result.updateError) {
        console.error('[raid-tag-completed] failed to mark cleared:', result.updateError);
        return;
      }

      const parts = [`**${lineup.name}** marked as cleared via \`Cleared\` tag.`];
      if (result.lootThread) parts.push(`Loot thread: <#${result.lootThread.id}>`);
      await newThread.send(parts.join('\n')).catch(err => {
        console.error('[raid-tag-completed] failed to send confirmation:', err);
      });

      console.log(`[raid-tag-completed] cleared lineup ${lineup.id} (${lineup.name}); players=${result.playersUpdated} tickets=${result.ticketsUpdated}`);
    } catch (err) {
      console.error('[raid-tag-completed] unexpected error:', err);
    } finally {
      inFlight.delete(newThread.id);
    }
  },
};

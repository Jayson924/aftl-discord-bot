const { Events, ChannelType } = require('discord.js');
const supabase = require('../supabase');
const { clearLineup, getCompletedTag } = require('../lib/clearLineup');

const RAID_THREAD_CHANNEL_ID = process.env.RAID_THREAD_CHANNEL_ID || '1496954808324587680';

// In-memory guard so the same thread can't be processed twice while the first
// run is still in flight (Discord can fire ThreadUpdate multiple times).
const inFlight = new Set();

module.exports = {
  name: Events.ThreadUpdate,
  async execute(oldThread, newThread) {
    // Only care about forum posts in the raid forum
    if (!newThread.parent || newThread.parent.type !== ChannelType.GuildForum) return;
    if (newThread.parent.id !== RAID_THREAD_CHANNEL_ID) return;

    const completedTag = getCompletedTag(newThread.parent);
    if (!completedTag) return;

    const wasCompleted = (oldThread.appliedTags || []).includes(completedTag.id);
    const isCompleted = (newThread.appliedTags || []).includes(completedTag.id);

    // Only fire on transition: not-completed -> completed
    if (wasCompleted || !isCompleted) return;

    if (inFlight.has(newThread.id)) return;
    inFlight.add(newThread.id);

    try {
      const { data: lineup, error } = await supabase
        .from('lineups')
        .select('id, name, raid_type, completed')
        .eq('thread_id', newThread.id)
        .limit(1)
        .single();

      if (error || !lineup) {
        console.log('[raid-tag-completed] No lineup linked to thread', newThread.id);
        return;
      }

      if (lineup.completed) return; // already handled (e.g. /clear ran first)

      // skipTag because the tag is already applied — that's what triggered us
      const result = await clearLineup({ lineup, raidThread: newThread, skipTag: true });

      if (result.updateError) {
        console.error('[raid-tag-completed] failed to mark cleared:', result.updateError);
        return;
      }

      const parts = [`**${lineup.name}** marked as cleared via \`Completed\` tag.`];
      if (result.lootThread) parts.push(`Loot thread: <#${result.lootThread.id}>`);
      await newThread.send(parts.join('\n')).catch(err => {
        console.error('[raid-tag-completed] failed to send confirmation:', err);
      });
    } catch (err) {
      console.error('[raid-tag-completed] unexpected error:', err);
    } finally {
      inFlight.delete(newThread.id);
    }
  },
};

const supabase = require('../supabase');
const { getLineupMentions, formatMentionList } = require('./lineupMentions');

// How often to check for upcoming raids (ms)
const CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

/**
 * Send a reminder message in the thread and update the lineup flag
 */
async function sendReminder(client, lineup, minutesUntil, flagColumn) {
  console.log(`[Reminders] Sending T-${minutesUntil}min reminder for lineup ${lineup.name} (${lineup.id})`);

  try {
    const thread = await client.channels.fetch(lineup.thread_id);
    if (!thread) {
      console.warn(`[Reminders] Thread ${lineup.thread_id} not found for lineup ${lineup.id}`);
      return;
    }

    const mentionGroups = await getLineupMentions(lineup.id);
    const mentions = formatMentionList(mentionGroups);

    const header = minutesUntil === 30
      ? `⏰ **Raid starting in 30 minutes!**`
      : `🔔 **Raid starting in 10 minutes — get ready!**`;

    const content = mentions ? `${header}\n${mentions}` : header;
    await thread.send(content);

    // Mark the flag so we don't send it again
    const { error: updateError } = await supabase
      .from('lineups')
      .update({ [flagColumn]: true })
      .eq('id', lineup.id);

    if (updateError) {
      console.error(`[Reminders] Failed to mark ${flagColumn} for lineup ${lineup.id}:`, updateError);
    }
  } catch (err) {
    console.error(`[Reminders] Failed to send T-${minutesUntil}min reminder for lineup ${lineup.id}:`, err);
  }
}

/**
 * Check for raids that need reminder pings and send them
 */
async function checkReminders(client) {
  const nowIso = new Date().toISOString();
  const in30Iso = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const in10Iso = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  // Common filter: has thread, has raid_time, not completed, raid_time is still in the future
  // --- 30-minute reminders ---
  const { data: due30, error: err30 } = await supabase
    .from('lineups')
    .select('id, name, thread_id, raid_time, reminder_30m_sent')
    .not('thread_id', 'is', null)
    .not('raid_time', 'is', null)
    .eq('completed', false)
    .eq('reminder_30m_sent', false)
    .gt('raid_time', nowIso)
    .lte('raid_time', in30Iso);

  if (err30) {
    console.error('[Reminders] Failed to query 30-min reminders:', err30);
  } else if (due30 && due30.length > 0) {
    for (const lineup of due30) {
      await sendReminder(client, lineup, 30, 'reminder_30m_sent');
    }
  }

  // --- 10-minute reminders ---
  const { data: due10, error: err10 } = await supabase
    .from('lineups')
    .select('id, name, thread_id, raid_time, reminder_10m_sent')
    .not('thread_id', 'is', null)
    .not('raid_time', 'is', null)
    .eq('completed', false)
    .eq('reminder_10m_sent', false)
    .gt('raid_time', nowIso)
    .lte('raid_time', in10Iso);

  if (err10) {
    console.error('[Reminders] Failed to query 10-min reminders:', err10);
  } else if (due10 && due10.length > 0) {
    for (const lineup of due10) {
      await sendReminder(client, lineup, 10, 'reminder_10m_sent');
    }
  }
}

/**
 * Start the reminder scheduler loop.
 * @param {import('discord.js').Client} client
 */
function startReminderScheduler(client) {
  console.log(`[Reminders] Starting scheduler (checking every ${CHECK_INTERVAL_MS / 1000}s)`);

  // Run once immediately on startup to catch anything due right now
  checkReminders(client).catch(err => {
    console.error('[Reminders] Initial check failed:', err);
  });

  return setInterval(() => {
    checkReminders(client).catch(err => {
      console.error('[Reminders] Scheduled check failed:', err);
    });
  }, CHECK_INTERVAL_MS);
}

module.exports = { startReminderScheduler };

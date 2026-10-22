const test = require('node:test');
const assert = require('node:assert/strict');
const { gameWeekStart, isCharacterEligible } = require('../src/lib/raidTypes');

// Thursday 2026-10-22 12:00 UTC; this game week began Friday 2026-10-16 16:00 UTC.
const NOW = new Date('2026-10-22T12:00:00Z');
const THIS_WEEK = '2026-10-20T09:00:00Z';
const LAST_WEEK = '2026-10-16T15:59:00Z';

const stage = (clears) => ({ name: 'stage', clears, entries: clears, limit: 10 });

test('game week starts Friday 16:00 UTC', () => {
  assert.equal(gameWeekStart(NOW).toISOString(), '2026-10-16T16:00:00.000Z');
  assert.equal(gameWeekStart(new Date('2026-10-23T15:59:59Z')).toISOString(), '2026-10-16T16:00:00.000Z');
  assert.equal(gameWeekStart(new Date('2026-10-23T16:00:00Z')).toISOString(), '2026-10-23T16:00:00.000Z');
});

test('no clears at all is eligible', () => {
  assert.equal(isCharacterEligible({}, 'DDN Hardcore', NOW), true);
});

test('game clear this week counts as done', () => {
  const c = { weekly_clears: { 17610: stage(1) }, weekly_clears_at: THIS_WEEK };
  assert.equal(isCharacterEligible(c, 'DDN Hardcore', NOW), false);
});

test('game clear from last week is ignored', () => {
  const c = { weekly_clears: { 17610: stage(1) }, weekly_clears_at: LAST_WEEK };
  assert.equal(isCharacterEligible(c, 'DDN Hardcore', NOW), true);
});

test('this week sync with zero clears is eligible', () => {
  const c = { weekly_clears: { 17610: stage(0) }, weekly_clears_at: THIS_WEEK };
  assert.equal(isCharacterEligible(c, 'DDN Hardcore', NOW), true);
});

test('manual mark only counts this week', () => {
  assert.equal(isCharacterEligible({ ddn_hardcore_completed: THIS_WEEK }, 'DDN Hardcore', NOW), false);
  assert.equal(isCharacterEligible({ ddn_hardcore_completed: LAST_WEEK }, 'DDN Hardcore', NOW), true);
});

test('stale game counts do not undo a manual mark', () => {
  const c = { ddn_hardcore_completed: THIS_WEEK, weekly_clears: { 17610: stage(0) }, weekly_clears_at: LAST_WEEK };
  assert.equal(isCharacterEligible(c, 'DDN Hardcore', NOW), false);
});

test('DDN Normal needs every stage cleared', () => {
  const partial = { weekly_clears: { 14210: stage(1), 14211: stage(1), 14212: stage(1), 14213: stage(0) }, weekly_clears_at: THIS_WEEK };
  const missing = { weekly_clears: { 14210: stage(1), 14211: stage(1), 14212: stage(1) }, weekly_clears_at: THIS_WEEK };
  const full = { weekly_clears: { 14210: stage(1), 14211: stage(1), 14212: stage(1), 14213: stage(2) }, weekly_clears_at: THIS_WEEK };
  assert.equal(isCharacterEligible(partial, 'DDN Normal', NOW), true);
  assert.equal(isCharacterEligible(missing, 'DDN Normal', NOW), true);
  assert.equal(isCharacterEligible(full, 'DDN Normal', NOW), false);
});

test('classic raids stay eligible until the ticket is used', () => {
  const base = { weekly_clears: { 14501: stage(1) }, weekly_clears_at: THIS_WEEK };
  assert.equal(isCharacterEligible(base, 'BDN Classic', NOW), true);
  assert.equal(isCharacterEligible({ ...base, tickets_used: { 'BDN Classic': THIS_WEEK } }, 'BDN Classic', NOW), false);
  assert.equal(isCharacterEligible({ tickets_used: { 'BDN Classic': THIS_WEEK } }, 'BDN Classic', NOW), true);
});

test('DDN Classic reads its own map id', () => {
  const c = { weekly_clears: { 14501: stage(1) }, weekly_clears_at: THIS_WEEK, tickets_used: { 'DDN Classic': THIS_WEEK } };
  assert.equal(isCharacterEligible(c, 'DDN Classic', NOW), true);
  c.weekly_clears[14221] = stage(1);
  assert.equal(isCharacterEligible(c, 'DDN Classic', NOW), false);
});

test('raid types without a completion column are always eligible', () => {
  assert.equal(isCharacterEligible({ weekly_clears: { 17610: stage(1) }, weekly_clears_at: THIS_WEEK }, '4-man', NOW), true);
});

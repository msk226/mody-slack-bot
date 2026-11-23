import test from 'node:test';
import assert from 'node:assert/strict';
import { duePeriod } from '../src/daily-report-trigger.js';

test('daily trigger is due once the report time passes each day', () => {
  assert.equal(duePeriod(Date.parse('2026-11-23T08:59:00+09:00'), '09:00'), null);
  assert.equal(duePeriod(Date.parse('2026-11-23T09:00:00+09:00'), '09:00'), '2026-11-23');
});

test('weekly trigger is keyed by Monday and catches up later in the week', () => {
  // 2026-11-23은 월요일
  assert.equal(duePeriod(Date.parse('2026-11-23T09:59:00+09:00'), '10:00', true), null);
  assert.equal(duePeriod(Date.parse('2026-11-23T10:00:00+09:00'), '10:00', true), '2026-11-23');
  assert.equal(duePeriod(Date.parse('2026-11-26T07:00:00+09:00'), '10:00', true), '2026-11-23');
  assert.equal(duePeriod(Date.parse('2026-11-29T23:59:00+09:00'), '10:00', true), '2026-11-23');
  assert.equal(duePeriod(Date.parse('2026-11-30T09:00:00+09:00'), '10:00', true), null);
});

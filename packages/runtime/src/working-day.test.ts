import { expect, test } from 'vitest';
import { callDates } from './working-day.js';

// 2026-11-16 is a Monday. Times are UTC; Malaysia is UTC+8.
const at = (iso: string) => callDates(new Date(iso)).next_working_day;

test('Monday to Thursday promise the next day', () => {
  expect(at('2026-11-16T02:00:00Z')).toBe('Tuesday, 17 November 2026');
  expect(at('2026-11-19T02:00:00Z')).toBe('Friday, 20 November 2026');
});
test('Friday, Saturday and Sunday promise Monday', () => {
  expect(at('2026-11-20T02:00:00Z')).toBe('Monday, 23 November 2026');
  expect(at('2026-11-21T02:00:00Z')).toBe('Monday, 23 November 2026');
  expect(at('2026-11-22T02:00:00Z')).toBe('Monday, 23 November 2026');
});
test('uses the Malaysian date, not UTC', () => {
  // Thursday 23:00 UTC is already Friday 07:00 in Malaysia.
  expect(at('2026-11-19T23:00:00Z')).toBe('Monday, 23 November 2026');
  expect(callDates(new Date('2026-11-19T23:00:00Z')).today_malaysia).toContain('Friday');
});
test('a broken clock gives no dates instead of failing', () => {
  expect(callDates(new Date(Number.NaN))).toEqual({});
});

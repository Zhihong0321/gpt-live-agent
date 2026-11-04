import { afterEach, expect, test, vi } from 'vitest';
import { ClosingDetector } from './closing.js';

afterEach(() => vi.useRealTimers());

test('waits for the complete closing, audio queue and two quiet seconds', () => {
  vi.useFakeTimers();
  const end = vi.fn(); let pending = true;
  const detector = new ClosingDetector(() => pending, end);
  detector.transcript('谢谢您的时间，');
  vi.advanceTimersByTime(3000);
  expect(end).not.toHaveBeenCalled();
  detector.transcript('祝你生意兴隆。');
  vi.advanceTimersByTime(2500);
  expect(end).not.toHaveBeenCalled();
  pending = false; detector.audio();
  vi.advanceTimersByTime(1900);
  expect(end).not.toHaveBeenCalled();
  vi.advanceTimersByTime(100);
  expect(end).toHaveBeenCalledOnce();
  detector.close();
});

test('does not end when closed before the delay', () => {
  vi.useFakeTimers(); const end = vi.fn();
  const detector = new ClosingDetector(() => false, end);
  detector.transcript('谢谢您的时间祝你生意兴隆');
  detector.close(); vi.advanceTimersByTime(3000);
  expect(end).not.toHaveBeenCalled();
});

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
  pending = false; const speech = Buffer.alloc(640); speech.writeInt16LE(10000, 0); speech.fill(speech.subarray(0, 2)); detector.audio(speech);
  vi.advanceTimersByTime(1900);
  expect(end).not.toHaveBeenCalled();
  vi.advanceTimersByTime(100);
  expect(end).toHaveBeenCalledOnce();
  detector.close();
});

test('continuous silent output does not prevent hangup after the new closing', () => {
  vi.useFakeTimers(); const end = vi.fn();
  const detector = new ClosingDetector(() => false, end);
  detector.transcript('代表恒浩能源祝您，'); detector.transcript('生意兴隆。');
  for (let i = 0; i < 20; i++) { detector.audio(Buffer.alloc(640)); vi.advanceTimersByTime(100); }
  expect(end).toHaveBeenCalledOnce();
});

test('does not end when closed before the delay', () => {
  vi.useFakeTimers(); const end = vi.fn();
  const detector = new ClosingDetector(() => false, end);
  detector.transcript('谢谢您的时间祝你生意兴隆');
  detector.close(); vi.advanceTimersByTime(3000);
  expect(end).not.toHaveBeenCalled();
});

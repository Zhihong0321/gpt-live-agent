import { it, expect } from 'vitest';
import { PcmFrameQueue, PcmPacer, frameBytes, pcmDurationMs } from './index.js';
it('frames odd network chunks without losing sample alignment and bounds memory', () => {
  const q = new PcmFrameQueue(24000, 20, 40);
  q.push(Buffer.alloc(959, 1)); expect(q.take()).toBeUndefined();
  q.push(Buffer.from([2])); expect(q.take()?.at(-1)).toBe(2);
  expect(frameBytes(48000)).toBe(1920);
  expect(pcmDurationMs(Buffer.alloc(960), 24000)).toBe(20);
  expect(() => q.push(Buffer.alloc(1921))).toThrow('backpressure');
});
it('paces silence and media without catchup bursts, releasing retained samples on stop', () => {
  const q = new PcmFrameQueue(16000); const frames: Buffer[] = [];
  const p = new PcmPacer(q, frame => frames.push(frame));
  expect(p.tick(0)).toBe(true); expect(p.tick(1)).toBe(false);
  expect(p.tick(1000)).toBe(true); expect(p.tick(1000)).toBe(false);
  expect(frames).toEqual([Buffer.alloc(640), Buffer.alloc(640)]);
  q.push(Buffer.alloc(10)); p.stop(); expect(q.bufferedBytes).toBe(0); expect(p.tick(2000)).toBe(false);
});
it('bounds playback and keeps the newest complete samples on overflow', () => {
  const q = new PcmFrameQueue(16000, 20, 20);
  q.push(Buffer.alloc(640, 1));
  q.pushLatest(Buffer.alloc(640, 2));
  expect(q.bufferedBytes).toBe(640);
  expect(q.take()).toEqual(Buffer.alloc(640, 2));
});
it('trims silence first and keeps speech in order under playback pressure', () => {
  const q = new PcmFrameQueue(16000, 20, 60);
  const speech1 = Buffer.alloc(640); const speech2 = Buffer.alloc(640);
  for (let i = 0; i < 640; i += 2) { speech1.writeInt16LE(10000, i); speech2.writeInt16LE(-10000, i); }
  q.push(Buffer.concat([speech1, Buffer.alloc(640)]));
  expect(q.pushPreferSpeech(speech2, 20)).toBe(640);
  expect(q.take()).toEqual(speech1);
  expect(q.take()).toEqual(speech2);
});
it('retains speech above the latency target until the hard buffer limit', () => {
  const q = new PcmFrameQueue(16000, 20, 60);
  const speech = Buffer.alloc(640); for (let i = 0; i < 640; i += 2) speech.writeInt16LE(10000, i);
  expect(q.pushPreferSpeech(Buffer.concat([speech, speech]), 20)).toBe(0);
  expect(q.bufferedBytes).toBe(1280);
  expect(q.pushPreferSpeech(Buffer.concat([speech, speech]), 20)).toBe(640);
  expect(q.bufferedBytes).toBe(1920);
});
it('maintains nominal cadence under recurring timer lateness for a full minute', () => {
  const q = new PcmFrameQueue(16000, 20, 500);
  let sent = 0, produced = 0, peak = 0;
  const p = new PcmPacer(q, () => { sent++; });
  // A nominal 5 ms timer is consistently 0.05 ms late; the source remains 20 ms.
  for (let tick = 1; tick * 5.05 <= 60000; tick++) {
    const now = tick * 5.05;
    while ((produced + 1) * 20 <= now) { q.push(Buffer.alloc(640)); produced++; }
    peak = Math.max(peak, q.bufferedBytes);
    p.tick(now);
  }
  expect(sent).toBeGreaterThanOrEqual(2999);
  expect(peak).toBeLessThanOrEqual(1280);
});
it('preserves ordinary deadlines but skips missed slots after a long stall', () => {
  const p = new PcmPacer(new PcmFrameQueue(16000), () => {});
  expect(p.tick(0)).toBe(true);
  expect(p.tick(23)).toBe(true);
  expect(p.tick(40)).toBe(true);
  expect(p.tick(1005)).toBe(true);
  expect(p.tick(1005)).toBe(false);
  expect(p.tick(1010)).toBe(false);
  expect(p.tick(1025)).toBe(true);
});

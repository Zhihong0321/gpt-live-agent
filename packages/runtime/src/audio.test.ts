import { expect, test, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { CallAudio } from './audio.js';
import type { RuntimeLive, VoiceDriver } from './types.js';

test('quiet or DTX calls keep paced silence until the platform ends them', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  const input = vi.fn();
  const fail = vi.fn();
  const voice: VoiceDriver = {
    rate: 16000, frameMs: 20,
    dial: async () => 'call', accept: async ref => ref, reject: async () => {},
    end: async () => {}, close: async () => {}, writeAudio: async () => {},
  };
  const live: RuntimeLive = {
    start() {}, appendAudio: input, close() {},
    commentary: () => 'c', instructions: () => 'i', thinking: () => 't',
  };
  const audio = new CallAudio(voice, 'call', 16000, live, fail);
  try {
    await vi.advanceTimersByTimeAsync(1800);
    expect(fail).not.toHaveBeenCalled();
    expect(input.mock.calls.length).toBeGreaterThan(50);
    expect(input.mock.calls.every(([pcm]) => pcm.equals(Buffer.alloc(640)))).toBe(true);
  } finally { audio.close(); vi.restoreAllMocks(); vi.useRealTimers(); }
});

test('duplex pacing survives a minute of recurring timer lateness without growing queues', async () => {
  let now = 0, tick!: () => void, produced = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(globalThis, 'setInterval').mockImplementation(callback => {
    tick = callback as () => void; return {} as ReturnType<typeof setInterval>;
  });
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
  const input = vi.fn(), output = vi.fn(async () => {}), fail = vi.fn();
  const voice: VoiceDriver = {
    rate: 16000, frameMs: 20,
    dial: async () => 'call', accept: async ref => ref, reject: async () => {},
    end: async () => {}, close: async () => {}, writeAudio: output,
  };
  const live: RuntimeLive = {
    start() {}, appendAudio: input, close() {},
    commentary: () => 'c', instructions: () => 'i', thinking: () => 't',
  };
  const audio = new CallAudio(voice, 'call', 16000, live, fail);
  try {
    for (let i = 1; i * 5.05 <= 60000; i++) {
      now = i * 5.05;
      while ((produced + 1) * 20 <= now) {
        audio.receive(Buffer.alloc(640)); audio.play(Buffer.alloc(640)); produced++;
      }
      tick();
      await Promise.resolve(); await Promise.resolve();
    }
    expect(fail).not.toHaveBeenCalled();
    expect(input.mock.calls.length).toBeGreaterThanOrEqual(2999);
    expect(output.mock.calls.length).toBe(input.mock.calls.length);
  } finally { audio.close(); vi.restoreAllMocks(); }
});

test('accepts a one-second burst of generated audio without ending the call', () => {
  const fail = vi.fn();
  const voice: VoiceDriver = {
    rate: 16000, frameMs: 20, dial: async () => 'call', accept: async ref => ref,
    reject: async () => {}, end: async () => {}, close: async () => {}, writeAudio: async () => {},
  };
  const live: RuntimeLive = {
    start() {}, appendAudio() {}, close() {},
    commentary: () => 'c', instructions: () => 'i', thinking: () => 't',
  };
  const audio = new CallAudio(voice, 'call', 16000, live, fail);
  try { audio.play(Buffer.alloc(32000)); expect(fail).not.toHaveBeenCalled(); }
  finally { audio.close(); }
});

test('does not disconnect when generated audio exceeds the playback buffer', () => {
  const fail = vi.fn();
  const voice: VoiceDriver = {
    rate: 16000, frameMs: 20, dial: async () => 'call', accept: async ref => ref,
    reject: async () => {}, end: async () => {}, close: async () => {}, writeAudio: async () => {},
  };
  const live: RuntimeLive = { start() {}, appendAudio() {}, close() {}, commentary: () => 'c', instructions: () => 'i', thinking: () => 't' };
  const audio = new CallAudio(voice, 'call', 16000, live, fail);
  try {
    audio.play(Buffer.alloc(160000));
    expect(fail).not.toHaveBeenCalled();
    expect(audio.metrics().max_output_queue_ms).toBe(1500);
    expect(audio.metrics().output_dropped_ms).toBe(3500);
  }
  finally { audio.close(); }
});

test('does not disconnect on an oversized inbound burst', () => {
  const fail = vi.fn();
  const voice: VoiceDriver = { rate: 16000, frameMs: 20, dial: async () => 'call', accept: async ref => ref,
    reject: async () => {}, end: async () => {}, close: async () => {}, writeAudio: async () => {} };
  const live: RuntimeLive = { start() {}, appendAudio() {}, close() {}, commentary: () => 'c', instructions: () => 'i', thinking: () => 't' };
  const audio = new CallAudio(voice, 'call', 16000, live, fail);
  try {
    audio.receive(Buffer.alloc(64000)); audio.receive(Buffer.alloc(640));
    expect(fail).not.toHaveBeenCalled();
    expect(audio.metrics().max_input_queue_ms).toBe(2000);
    expect(audio.metrics().input_dropped_ms).toBe(20);
    expect(audio.metrics().input_audible_dropped_ms).toBe(0);
  }
  finally { audio.close(); }
});

test('reports audible incoming audio lost during overload without saving it', () => {
  const fail = vi.fn();
  const voice: VoiceDriver = { rate: 16000, frameMs: 20, dial: async () => 'call', accept: async ref => ref,
    reject: async () => {}, end: async () => {}, close: async () => {}, writeAudio: async () => {} };
  const live: RuntimeLive = { start() {}, appendAudio() {}, close() {}, commentary: () => 'c', instructions: () => 'i', thinking: () => 't' };
  const audio = new CallAudio(voice, 'call', 16000, live, fail);
  const speech = Buffer.alloc(64000); for (let i = 0; i < speech.length; i += 2) speech.writeInt16LE(10000, i);
  try {
    audio.receive(speech); audio.receive(Buffer.alloc(640));
    expect(audio.metrics().input_audible_dropped_ms).toBe(20);
    expect(fail).not.toHaveBeenCalled();
  } finally { audio.close(); }
});

test('does not disconnect when a phone write briefly remains pending', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  const fail = vi.fn();
  const voice: VoiceDriver = { rate: 16000, frameMs: 20, dial: async () => 'call', accept: async ref => ref,
    reject: async () => {}, end: async () => {}, close: async () => {}, writeAudio: () => new Promise(() => {}) };
  const live: RuntimeLive = { start() {}, appendAudio() {}, close() {}, commentary: () => 'c', instructions: () => 'i', thinking: () => 't' };
  const audio = new CallAudio(voice, 'call', 16000, live, fail);
  try { await vi.advanceTimersByTimeAsync(100); expect(fail).not.toHaveBeenCalled(); }
  finally { audio.close(); vi.restoreAllMocks(); vi.useRealTimers(); }
});

test.each([
  ['live', 'audio_live_write_failed'], ['phone', 'audio_phone_write_failed'],
] as const)('reports the fixed %s audio failure category once without raw errors', async (boundary, reason) => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  const fail = vi.fn();
  const voice: VoiceDriver = {
    rate: 16000, frameMs: 20,
    dial: async () => 'call', accept: async ref => ref, reject: async () => {},
    end: async () => {}, close: async () => {},
    writeAudio: async () => {
      if (boundary === 'phone') throw new Error('private provider details');
    },
  };
  const live: RuntimeLive = {
    start() {}, appendAudio() { if (boundary === 'live') throw new Error('private provider details'); }, close() {},
    commentary: () => 'c', instructions: () => 'i', thinking: () => 't',
  };
  const audio = new CallAudio(voice, 'call', 16000, live, fail);
  try {
    await vi.advanceTimersByTimeAsync(50);
    expect(fail.mock.calls).toEqual([[reason]]);
  } finally { audio.close(); vi.restoreAllMocks(); vi.useRealTimers(); }
});

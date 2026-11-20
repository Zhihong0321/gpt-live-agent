import { test, expect, vi } from 'vitest';
import { CallStore } from '@voxdock/core';
import { parseConfig } from '@voxdock/config';
import { createRuntime, type VoiceEvents } from './index.js';

const config = () => parseConfig({
  calling: { enabled: true, ring_timeout_seconds: 1, max_call_seconds: 2 },
  security: { control_token_file: 'control.key' },
  channels: { telegram: { enabled: true, account_ref: 'owner', api_id_env: 'TG_APP', api_hash_file: 'app.key', session_file: 'session' } },
  targets: [{ id: 'self', channel: 'telegram', account_ref: 'owner', peer_id_env: 'TG_PEER', principal_ref: 'owner', enabled: true }],
  live: { api_key_file: 'live.key' },
  backend: { id: 'business', base_url: 'https://backend.invalid', request_token_file: 'backend.key', event_signing_key_file: 'signing.key' },
});
const driver = () => ({ rate: 48000 as const, frameMs: 10 as const, dial: vi.fn(), accept: vi.fn(), reject: vi.fn(async () => {}), end: vi.fn(async () => {}), writeAudio: vi.fn(async () => {}), close: vi.fn(async () => {}) });

test('a channel that is not up at startup keeps retrying until it connects', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {});
  const store = new CallStore(':memory:');
  let tries = 0;
  const voice = vi.fn(async () => { if (++tries < 3) throw new Error('session not open yet'); return driver(); });
  const runtime = await createRuntime({ config: config(), store }, { backend: { context: vi.fn(), delegate: vi.fn(), deliverEvent: vi.fn() }, voice, live: vi.fn(), environment: () => '123' });
  try {
    expect(runtime.readyChannels.has('telegram')).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(runtime.readyChannels.has('telegram')).toBe(false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(tries).toBe(3);
    expect(runtime.readyChannels.has('telegram')).toBe(true);
  } finally { await runtime.close(); store.close(); vi.useRealTimers(); vi.restoreAllMocks(); }
});

test('a channel that drops while running reconnects by itself', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {});
  const store = new CallStore(':memory:');
  const events: VoiceEvents[] = [];
  const drivers: Array<ReturnType<typeof driver>> = [];
  const voice = vi.fn(async (_target: unknown, _peer: string, callbacks: VoiceEvents) => { events.push(callbacks); const d = driver(); drivers.push(d); return d; });
  const runtime = await createRuntime({ config: config(), store }, { backend: { context: vi.fn(), delegate: vi.fn(), deliverEvent: vi.fn() }, voice, live: vi.fn(), environment: () => '123' });
  try {
    expect(runtime.readyChannels.has('telegram')).toBe(true);
    events[0]!.fault();
    expect(runtime.readyChannels.has('telegram')).toBe(false);
    expect(drivers[0]!.close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(voice).toHaveBeenCalledTimes(2);
    expect(runtime.readyChannels.has('telegram')).toBe(true);
  } finally { await runtime.close(); store.close(); vi.useRealTimers(); vi.restoreAllMocks(); }
});

test('closing stops the retries', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {});
  const store = new CallStore(':memory:');
  const voice = vi.fn(async () => { throw new Error('down'); });
  const runtime = await createRuntime({ config: config(), store }, { backend: { context: vi.fn(), delegate: vi.fn(), deliverEvent: vi.fn() }, voice, live: vi.fn(), environment: () => '123' });
  await runtime.close(); store.close();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(voice).toHaveBeenCalledTimes(1);
  vi.useRealTimers(); vi.restoreAllMocks();
});

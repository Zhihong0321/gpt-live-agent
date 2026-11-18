import { test, expect, vi } from 'vitest';
import { CallStore } from '@voxdock/core';
import { parseConfig } from '@voxdock/config';
import type { LiveEvent } from '@voxdock/live';
import { PassThrough } from 'node:stream';
import { createRuntime, type VoiceEvents } from './index.js';
import { DialRejected } from './types.js';

const config = () => parseConfig({
  calling: { enabled: true, ring_timeout_seconds: 5, max_call_seconds: 5 },
  security: { control_token_file: 'control.key' },
  channels: { whatsapp: { enabled: true, account_ref: 'owner', endpoint: 'http://127.0.0.1:9', media_token_file: 'media.key' } },
  targets: [{ id: 'self', channel: 'whatsapp', account_ref: 'owner', peer_id: '60111111111', principal_ref: 'owner', enabled: true }],
  live: { api_key_file: 'live.key' },
  visitor_calls: {},
  backend: { id: 'business', base_url: 'https://backend.invalid', request_token_file: 'backend.key', event_signing_key_file: 'signing.key' },
});

async function fixture(dial: (peer: string) => Promise<string>) {
  const store = new CallStore(':memory:');
  let callbacks!: VoiceEvents;
  const thinking: string[] = [];
  const context = vi.fn();
  const runtime = await createRuntime({ config: config(), store }, {
    backend: { context, delegate: vi.fn(), deliverEvent: vi.fn() }, environment: () => '1', resampler: () => new PassThrough(),
    voice: async (_target, _peer, events) => { callbacks = events; return {
      rate: 16000, frameMs: 20,
      dial: async peer => { const ref = await dial(peer); callbacks.state(ref, 'connected'); callbacks.audioReady(ref); return ref; },
      accept: vi.fn(), reject: vi.fn(),
      end: async ref => { callbacks.state(ref, 'ended'); }, writeAudio: async () => {}, close: async () => {},
    }; },
    live: (_settings, emit: (event: LiveEvent) => void) => ({
      start() { emit({ type: 'ready', sessionId: 'session' }); },
      appendAudio() {}, commentary: () => 'c', thinking: text => { thinking.push(text); return 't'; }, instructions: () => 'i',
      close() { emit({ type: 'closed', finalization: 'complete', reason: 'closed', seconds: 1 }); },
    }),
  });
  const visit = (key: string, input: { phone?: string; name?: string; company?: string } = { name: 'Ali', company: 'ACME Sdn Bhd' }) =>
    store.createVisitorCall({ request_ref: key, phone: input.phone ?? '+60123456789', ...(input.name ? { name: input.name } : {}), ...(input.company ? { company: input.company } : {}) },
      { enabled: true, maxTtlSeconds: 300, maxPerNumberPerDay: 2 });
  const flush = () => new Promise(resolve => setTimeout(resolve, 50));
  return { store, runtime, visit, thinking, context, flush, async close() { await runtime.close(); store.close(); } };
}

test('a visitor call dials the visitor number and briefs the agent from the form, not from the backend', async () => {
  const dial = vi.fn(async () => 'provider');
  const f = await fixture(dial);
  try {
    const { call } = f.visit('req-1');
    await f.runtime.onCallCreated(call);
    await f.flush();
    expect(dial).toHaveBeenCalledWith('+60123456789');
    expect(f.context).not.toHaveBeenCalled();
    const briefing = f.thinking.join(' ');
    expect(briefing).toContain('Visitor name (as typed on the form): Ali');
    expect(briefing).toContain('Visitor company (as typed on the form): ACME Sdn Bhd');
    expect(briefing).toContain('never ask for it');
    expect(f.store.getCall(call.call_id).state).toBe('connected');
  } finally { await f.close(); }
});

test('a number the platform refuses ends the call cleanly and does not block the next visitor', async () => {
  let attempts = 0;
  const f = await fixture(async () => { attempts++; if (attempts === 1) throw new DialRejected('platform rejected'); return 'provider'; });
  try {
    const first = f.visit('req-a', { name: 'Not On WhatsApp', phone: '+60120000000' });
    await f.runtime.onCallCreated(first.call);
    await f.flush();
    expect(f.store.getCall(first.call.call_id)).toMatchObject({ state: 'ended', reason: 'dial_rejected' });
    const second = f.visit('req-b', { name: 'Next Visitor', phone: '+60121111111' });
    await f.runtime.onCallCreated(second.call);
    await f.flush();
    expect(f.store.getCall(second.call.call_id).state).toBe('connected');
  } finally { await f.close(); }
});

test('the store requires a name or a company, a valid number, is idempotent and limits repeat numbers', async () => {
  const f = await fixture(async () => 'provider');
  try {
    expect(() => f.visit('r1', { name: ' ', company: '' })).toThrow(/name_or_company_required/);
    expect(() => f.visit('r2', { phone: '012345', name: 'A' })).toThrow(/invalid_phone/);
    const first = f.visit('r3', { name: 'Same' });
    expect(f.visit('r3', { name: 'Same' })).toMatchObject({ replayed: true, call: { call_id: first.call.call_id } });
    const talk = (id: string) => { f.store.transition(id, 'dialing'); f.store.transition(id, 'connected'); f.store.transition(id, 'ended', { reason: 'test' }); };
    talk(first.call.call_id);
    const second = f.visit('r4', { name: 'Same' });
    talk(second.call.call_id);
    expect(() => f.visit('r5', { name: 'Same' })).toThrow(/phone_limit/);
    expect(f.visit('r6', { name: 'Other', phone: '+60129999999' }).replayed).toBe(false);
  } finally { await f.close(); }
});

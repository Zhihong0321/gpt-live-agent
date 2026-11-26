import { randomBytes, scryptSync } from 'node:crypto';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { CallStore } from '@voxdock/core';
import { registerScriptsPage } from './scripts-page.js';

const testKey = 'test-key-for-scripts';
const salt = randomBytes(16);
const opts = { enabled: true, allowedTargets: new Set(['owner']), maxTtlSeconds: 300 };

async function setup() {
  const store = new CallStore(':memory:');
  const call = store.createCall('operator', 'k1', { target_id: 'owner', context_ref: 'c', correlation_ref: 'r', expires_at: new Date(Date.now() + 60_000).toISOString() }, opts).call;
  store.transition(call.call_id, 'connected', { provider_call_ref: 'p:1' });
  store.appendTranscript(call.call_id, { id: 'f1', session_id: 's1', speaker: 'assistant', seq: 0, start_ms: 0, end_ms: 900, text: 'Hello <there>', final: true, context_revision: 1 });
  store.appendTranscript(call.call_id, { id: 'f2', session_id: 's1', speaker: 'user', seq: 1, start_ms: 1000, end_ms: 1900, text: 'Not interested', final: true, context_revision: 1 });
  store.transition(call.call_id, 'ended', { reason: 'completed' });
  const empty = store.createCall('operator', 'k2', { target_id: 'owner', context_ref: 'c2', correlation_ref: 'r2', expires_at: new Date(Date.now() + 60_000).toISOString() }, opts).call;
  store.transition(empty.call_id, 'ended', { reason: 'no_answer' });
  const app = Fastify();
  registerScriptsPage(app, { store, controlToken: 'x'.repeat(40), key: { salt, hash: scryptSync(testKey, salt, 32) } });
  return app;
}

it('asks for the access key, rejects a wrong one, and shows every call after the right one', async () => {
  const app = await setup();
  const locked = await app.inject({ url: '/scripts' });
  expect(locked.body).toContain('Access key');
  expect(locked.body).not.toContain('Not interested');
  expect((await app.inject({ url: '/scripts/list' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/scripts/key', payload: { key: 'wrong' } })).statusCode).toBe(401);

  const ok = await app.inject({ method: 'POST', url: '/scripts/key', payload: { key: testKey } });
  expect(ok.statusCode).toBe(204);
  const cookie = String(ok.headers['set-cookie']).split(';')[0]!;
  const open = await app.inject({ url: '/scripts', headers: { cookie } });
  expect(open.body).toContain('Hello &lt;there&gt;');
  expect(open.body).toContain('Not interested');
  expect(open.body).toContain('No conversation was recorded for this call.');
  expect(open.body).toContain('2 calls');

  const file = await app.inject({ url: '/scripts/download.txt', headers: { cookie } });
  expect(file.headers['content-disposition']).toContain('attachment');
  expect(file.body).toContain('Agent: Hello <there>');
  expect(file.body).toContain('Customer: Not interested');

  expect((await app.inject({ url: '/scripts/list', headers: { cookie: `${cookie.slice(0, -2)}xx` } })).statusCode).toBe(401);
});

it('opens with the real key hash built in', async () => {
  const app = Fastify();
  registerScriptsPage(app, { store: new CallStore(':memory:'), controlToken: 'x'.repeat(40) });
  expect((await app.inject({ method: 'POST', url: '/scripts/key', payload: { key: 'wrong' } })).statusCode).toBe(401);
});

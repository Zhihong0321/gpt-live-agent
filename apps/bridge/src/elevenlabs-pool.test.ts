import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { chooseLive, livePicker, poolFileFor, readPool, runCycle, syncAgent, writePool, type Pool, type PoolKey } from './elevenlabs-pool.js';
import { registerKeysAdmin } from './keys-admin.js';
import type { ConsoleAccountStore } from './console-account.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { vi.unstubAllGlobals(); while (cleanups.length) await cleanups.pop()!(); });
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'pool-')); cleanups.push(() => rmSync(d, { recursive: true, force: true })); return d; };
const ok = (remaining: number) => ({ ok: true, checked_at: 'now', used: 100000 - remaining, limit: 100000, remaining });
const key = (id: string, remaining: number, copy: string | null, problem: string | null = null): PoolKey =>
  ({ id, label: id, key: `sk_${id}_xxxxxxxxxxxxxxxxxxxx`, added_at: '', check: ok(remaining), copies: { agent_main: { agent_id: copy, source_hash: 'h', synced_at: 'now', problem } } });

it('uses key 1 while it is unchecked or above the floor', () => {
  expect(chooseLive({ min_credits: 5000, keys: [key('b', 90000, 'agent_b')] }, 'agent_main', 'sk_1')).toMatchObject({ apiKey: 'sk_1', agentId: 'agent_main', key: 'key 1' });
  expect(chooseLive({ min_credits: 5000, primary_check: ok(6000), keys: [key('b', 90000, 'agent_b')] }, 'agent_main', 'sk_1').key).toBe('key 1');
});

it('moves new calls to the next ready key when key 1 is low, skipping keys that are low, failing or have no good copy', () => {
  const pool: Pool = { min_credits: 5000, primary_check: ok(100), keys: [key('low', 10, 'agent_low'), key('voice', 90000, 'agent_v', 'voice missing'), key('nocopy', 90000, null), key('good', 90000, 'agent_good')] };
  expect(chooseLive(pool, 'agent_main', 'sk_1')).toMatchObject({ apiKey: 'sk_good_xxxxxxxxxxxxxxxxxxxx', agentId: 'agent_good', key: 'good' });
});

it('falls back to key 1 when no other key is ready, never refusing the call', () => {
  const pool: Pool = { min_credits: 5000, primary_check: { ok: false, checked_at: 'now', error: 'HTTP 401' }, keys: [key('low', 10, 'agent_low')] };
  expect(chooseLive(pool, 'agent_main', 'sk_1')).toMatchObject({ apiKey: 'sk_1', agentId: 'agent_main', reason: expect.stringContaining('used anyway') });
});

it('finds the pool in the main folder from a user folder, and a broken pool file means key 1', () => {
  expect(poolFileFor(join('data', 'users', 'user001'))).toBe(join('data', 'elevenlabs-pool.json'));
  expect(poolFileFor('data')).toBe(join('data', 'elevenlabs-pool.json'));
  const d = dir(); writeFileSync(join(d, 'elevenlabs-pool.json'), '{broken');
  const logs: string[] = [];
  expect(readPool(join(d, 'elevenlabs-pool.json'), l => logs.push(l)).keys).toEqual([]);
  expect(logs).toHaveLength(1);
  expect(livePicker(d, () => {})('agent_main', 'sk_1')).toMatchObject({ apiKey: 'sk_1', agentId: 'agent_main' });
});

function fakeElevenLabs(options: { voiceMissing?: boolean } = {}) {
  const agents = new Map<string, { key: string; config: unknown }>([['agent_main', { key: 'sk_1', config: { agent: { prompt: { prompt: 'p1', temperature: 0.5 } }, tts: { voice_id: 'voice1' } } }]]);
  const calls: string[] = [];
  let n = 0;
  const fetcher = (async (url: string, init?: RequestInit) => {
    const k = (init?.headers as Record<string, string>)['xi-api-key']!; const method = init?.method ?? 'GET'; const path = String(url).replace('https://api.elevenlabs.io', '');
    calls.push(`${method} ${path} ${k}`);
    if (path === '/v1/user/subscription') return new Response(JSON.stringify(k === 'sk_1' ? { tier: 'pro', character_count: 99000, character_limit: 100000 } : { tier: 'creator', character_count: 1000, character_limit: 100000, next_character_count_reset_unix: 1800000000 }));
    if (path.startsWith('/v1/voices/')) return new Response('{}', { status: options.voiceMissing ? 404 : 200 });
    if (path === '/v1/convai/agents/create') { const id = `agent_copy${++n}`; agents.set(id, { key: k, config: JSON.parse(String(init!.body)).conversation_config }); return new Response(JSON.stringify({ agent_id: id })); }
    const id = path.split('/').pop()!; const agent = agents.get(id);
    if (!agent || agent.key !== k) return new Response('{}', { status: 404 });
    if (method === 'PATCH') { agent.config = JSON.parse(String(init!.body)).conversation_config; return new Response('{}'); }
    return new Response(JSON.stringify({ name: 'Main agent', conversation_config: agent.config }));
  }) as typeof fetch;
  return { agents, calls, fetcher };
}

it('copies the agent into a new account, skips when unchanged, refreshes after a change', async () => {
  const el = fakeElevenLabs();
  const target = key('b', 90000, null); target.copies = {};
  const first = await syncAgent('sk_1', 'agent_main', target, el.fetcher);
  expect(first).toMatchObject({ agent_id: 'agent_copy1', problem: null });
  expect(el.agents.get('agent_copy1')).toMatchObject({ key: target.key, config: { agent: { prompt: { prompt: 'p1', temperature: 0.5 } } } });
  target.copies.agent_main = first;
  el.calls.length = 0;
  expect(await syncAgent('sk_1', 'agent_main', target, el.fetcher)).toEqual(first);
  expect(el.calls.filter(c => !c.startsWith('GET /v1/convai/agents/agent_main'))).toEqual([]);
  el.agents.get('agent_main')!.config = { agent: { prompt: { prompt: 'p2', temperature: 0.5 } }, tts: { voice_id: 'voice1' } };
  const second = await syncAgent('sk_1', 'agent_main', target, el.fetcher);
  expect(second.agent_id).toBe('agent_copy1');
  expect(el.agents.get('agent_copy1')!.config).toMatchObject({ agent: { prompt: { prompt: 'p2' } } });
});

it('labels a copy whose voice is missing in the other account, so that key is not used', async () => {
  const el = fakeElevenLabs({ voiceMissing: true });
  const target = key('b', 90000, null); target.copies = {};
  const copy = await syncAgent('sk_1', 'agent_main', target, el.fetcher);
  expect(copy.agent_id).toBe('agent_copy1');
  expect(copy.problem).toContain('voice voice1 is not in this account');
});

it('a monitor round checks credits, copies agents and records which key new calls use', async () => {
  const d = dir(); const file = join(d, 'elevenlabs-pool.json');
  const el = fakeElevenLabs();
  const extra = key('b', 0, null); extra.copies = {}; delete extra.check;
  writePool(file, { min_credits: 5000, keys: [extra] });
  const pool = await runCycle(file, 'sk_1', ['agent_main'], () => {}, el.fetcher);
  expect(pool.primary_check).toMatchObject({ ok: true, remaining: 1000 });
  expect(pool.keys[0]!.check).toMatchObject({ ok: true, remaining: 99000, tier: 'creator' });
  expect(pool.keys[0]!.copies.agent_main).toMatchObject({ agent_id: 'agent_copy1', problem: null });
  expect(pool.choice).toBe('b');
  expect(JSON.parse(readFileSync(file, 'utf8')).choice).toBe('b');
});

it('admin page: main login only, same-origin changes, keys never shown in full', async () => {
  const d = dir(); const file = join(d, 'elevenlabs-pool.json');
  writeFileSync(join(d, 'primary'), 'sk_primary_key_abcdefghij1234');
  const el = fakeElevenLabs(); el.agents.get('agent_main')!.key = 'sk_primary_key_abcdefghij1234'; vi.stubGlobal('fetch', el.fetcher);
  const account = { read: () => ({ username: 'admin', revision: 1, allow_remote_management: true }), credentialRevision: () => 1,
    authenticate: async (u: string, p: string) => u === 'admin' && p === 'right-password-123', update: async () => { throw new Error(); }, recover: async () => { throw new Error(); } } as ConsoleAccountStore;
  const app = Fastify();
  registerKeysAdmin(app, { account, controlToken: 'c'.repeat(64), publicOrigin: 'https://example.test', poolFile: file, mainData: d, primaryKeyFile: join(d, 'primary'), mainAgent: 'agent_main', log: () => {} });
  cleanups.push(() => app.close());
  const origin = { origin: 'https://example.test' };
  expect((await app.inject({ url: '/admin' })).body).toContain('ElevenLabs keys');
  expect((await app.inject({ url: '/admin/keys/state' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/admin/keys/login', headers: origin, payload: { username: 'admin', password: 'wrong-password-x' } })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/admin/keys/login', payload: { username: 'admin', password: 'right-password-123' } })).statusCode).toBe(403);
  const login = await app.inject({ method: 'POST', url: '/admin/keys/login', headers: origin, payload: { username: 'admin', password: 'right-password-123' } });
  expect(login.statusCode).toBe(200);
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  expect((await app.inject({ method: 'POST', url: '/admin/keys/add', headers: { cookie }, payload: { key: 'sk_b_xxxxxxxxxxxxxxxxxxxxxxxx' } })).statusCode).toBe(403);
  const add = await app.inject({ method: 'POST', url: '/admin/keys/add', headers: { cookie, ...origin }, payload: { label: 'Account B', key: 'sk_b_xxxxxxxxxxxxxxxxxxxxxxxx' } });
  expect(add.statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: '/admin/keys/add', headers: { cookie, ...origin }, payload: { key: 'sk_b_xxxxxxxxxxxxxxxxxxxxxxxx' } })).statusCode).toBe(409);
  expect((await app.inject({ method: 'POST', url: '/admin/keys/settings', headers: { cookie, ...origin }, payload: { min_credits: 2000 } })).statusCode).toBe(200);
  const refreshed = await app.inject({ method: 'POST', url: '/admin/keys/refresh', headers: { cookie, ...origin } });
  expect(refreshed.statusCode).toBe(200);
  const state = await app.inject({ url: '/admin/keys/state', headers: { cookie } });
  expect(state.body).not.toContain('sk_b_xxxxxxxxxxxxxxxxxxxxxxxx');
  expect(state.body).not.toContain('sk_primary_key_abcdefghij1234');
  const s = state.json();
  expect(s.min_credits).toBe(2000);
  expect(s.keys.map((k: { label: string; last4: string }) => [k.label, k.last4])).toEqual([['Key 1 (Railway ELEVENLABS_API_KEY)', '…1234'], ['Account B', '…xxxx']]);
  expect(s.keys[1].copies.agent_main.agent_id).toBe('agent_copy1');
  const id = s.keys[1].id;
  expect((await app.inject({ method: 'POST', url: '/admin/keys/remove', headers: { cookie, ...origin }, payload: { id } })).statusCode).toBe(200);
  expect((await app.inject({ url: '/admin/keys/state', headers: { cookie } })).json().keys).toHaveLength(1);
});

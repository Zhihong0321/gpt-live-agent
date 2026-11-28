import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parseConfig } from '@voxdock/config';
import { CallStore } from '@voxdock/core';
import { createBridgeServer } from './server.js';
import type { ConsoleAccountStore } from './console-account.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.unstubAllGlobals(); while (cleanups.length) await cleanups.pop()!(); });

const account: ConsoleAccountStore = {
  read: () => ({ username: 'user001', revision: 1, allow_remote_management: true }),
  credentialRevision: () => 1,
  authenticate: async (username, password) => username === 'user001' && password === 'made-up-test-pass-42',
  update: async () => { throw new Error('unused'); },
  recover: async () => { throw new Error('unused'); },
};
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const good = basic('user001', 'made-up-test-pass-42');

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'user-mcp-'));
  writeFileSync(join(dir, 'key'), 'test-elevenlabs-key');
  const config = parseConfig({
    schema_version: 1, service: { listen: '127.0.0.1:8787', data_dir: dir }, security: { control_token_file: join(dir, 'c') },
    visitor_calls: { max_per_number_per_day: 2 },
    live: { api_key_file: join(dir, 'key'), elevenlabs: { agent_ids: { telegram: 'agent_t', whatsapp: 'agent_own' } }, language: 'en', instructions: 'x' },
  });
  const store = new CallStore(':memory:');
  const app = await createBridgeServer({ store, config, controlToken: 'c'.repeat(64), dataDirectory: dir,
    console: { account, publicOrigin: 'https://example.test', assetsDirectory: dir } });
  cleanups.push(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  let id = 0;
  const mcp = async (method: string, params: unknown, authorization = good) => {
    const response = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      payload: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const text = response.body;
    const data = text.startsWith('{') ? text : (text.split('\n').find(line => line.startsWith('data:')) ?? 'data:{}').slice(5);
    return { status: response.statusCode, json: JSON.parse(data) };
  };
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await mcp('tools/call', { name, arguments: args });
    return { isError: !!r.json.result?.isError, data: JSON.parse(r.json.result?.content?.[0]?.text ?? '{}') };
  };
  return { app, dir, mcp, tool };
}

it('asks for the console login and refuses a wrong password', async () => {
  const { mcp } = await setup();
  expect((await mcp('tools/list', {}, '')).status).toBe(401);
  expect((await mcp('tools/list', {}, basic('user001', 'wrong-password'))).status).toBe(401);
  expect((await mcp('tools/list', {}, basic('user002', 'made-up-test-pass-42'))).status).toBe(401);
});

it('stops answering after 10 failed logins in a minute, with a clear message', async () => {
  const { mcp } = await setup();
  for (let i = 0; i < 10; i++) await mcp('tools/list', {}, basic('user001', `bad-password-${i}`));
  const r = await mcp('tools/list', {}, good);
  expect(r.status).toBe(429);
  expect(r.json.error).toBe('too_many_failed_logins');
});

it('lists the user tools and answers whoami, calls, usage and settings', async () => {
  const { mcp, tool } = await setup();
  const list = await mcp('tools/list', {});
  expect(list.status).toBe(200);
  const names = list.json.result.tools.map((t: { name: string }) => t.name).sort();
  expect(names).toEqual(['call_number', 'end_call', 'get_agent_prompt', 'get_call', 'get_call_script', 'get_settings', 'list_calls', 'list_prompt_history', 'restore_prompt', 'setup_status', 'update_agent_prompt', 'update_settings', 'usage', 'whatsapp_status', 'whoami']);
  const me = await tool('whoami');
  expect(me.data).toMatchObject({ username: 'user001', agent_id: 'agent_own', shared_default_agent: false });
  expect((await tool('list_calls')).isError).toBe(false);
  expect((await tool('usage', { days: '7' })).isError).toBe(false);
  // Without a runtime manager the settings route answers 503; the tool labels it instead of failing silently.
  const settings = await tool('get_settings');
  expect(settings.isError).toBe(true);
  expect(settings.data.error.http_status).toBe(503);
});

it('labels a call request while calling is off, and never hides it', async () => {
  const { tool } = await setup();
  const r = await tool('call_number', { phone: '+60123456789', name: 'Test Lead' });
  expect(r.isError).toBe(true);
  expect(r.data.error.http_status).toBeGreaterThanOrEqual(400);
  // The real reason, in plain words, with the steps and the user's console link.
  expect(r.data.error.meaning).toContain('setup is not finished');
  expect(r.data.error.setup.steps[0]).toMatchObject({ step: 1, done: false, who: 'you (on your phone, in the console)' });
  expect(r.data.error.setup.console).toBe('https://example.test/console/');
});

it('setup_status lists each step, who does it and the console link; whoami says if ready to call', async () => {
  const { tool } = await setup();
  const s = await tool('setup_status');
  expect(s.isError).toBe(false);
  expect(s.data.ready_to_call).toBe(false);
  expect(s.data.steps.map((x: { name: string }) => x.name)).toEqual(['Link the WhatsApp that makes the calls', 'Pair a receiving number', 'Turn on WhatsApp', 'Turn on calling']);
  expect(s.data.steps[0].how).toContain('https://example.test/console/');
  expect(s.data.next_step).toContain('Step 1');
  // Settings cannot be read in this test bridge: written on the answer, not hidden.
  expect(s.data.problem).toContain('settings HTTP 503');
  const me = await tool('whoami');
  expect(me.data).toMatchObject({ username: 'user001', ready_to_call: false, console: 'https://example.test/console/' });
  expect(me.data.setup_next_step).toContain('Step 1');
});

it('updates the own agent prompt with history and can restore it', async () => {
  const { dir, tool } = await setup();
  let agent = { prompt: 'old prompt', first_message: '' };
  const patches: unknown[] = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).startsWith('https://api.elevenlabs.io/')) return realFetch(url, init);
    expect(String(url)).toContain('/agent_own');
    expect((init?.headers as Record<string, string>)['xi-api-key']).toBe('test-elevenlabs-key');
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)); patches.push(body);
      agent = { prompt: body.conversation_config.agent.prompt?.prompt ?? agent.prompt, first_message: body.conversation_config.agent.first_message ?? agent.first_message };
      return new Response('{}');
    }
    return new Response(JSON.stringify({ conversation_config: { agent: { prompt: { prompt: agent.prompt, temperature: 0.5 }, first_message: agent.first_message } } }));
  });
  expect((await tool('get_agent_prompt')).data).toMatchObject({ prompt: 'old prompt' });
  const changed = await tool('update_agent_prompt', { prompt: 'new prompt', note: 'shorter opening' });
  expect(changed.data).toMatchObject({ changed: true, previous_version_saved: 1 });
  // Only the prompt text is sent, so ElevenLabs keeps the agent's other prompt settings.
  expect(patches[0]).toEqual({ conversation_config: { agent: { prompt: { prompt: 'new prompt' } } } });
  const history = await tool('list_prompt_history');
  expect(history.data.versions[0]).toMatchObject({ version: 1, by: 'user001', note: 'shorter opening', prompt_start: 'old prompt' });
  expect((await tool('restore_prompt', { version: 1 })).data).toMatchObject({ changed: true, previous_version_saved: 2 });
  expect(agent.prompt).toBe('old prompt');
  expect(JSON.parse(readFileSync(join(dir, 'prompt-history.json'), 'utf8'))).toHaveLength(2);
  expect((await tool('restore_prompt', { version: 99 })).data).toMatchObject({ changed: false });
});

it('never reads or changes the shared default agent', async () => {
  const { dir, tool } = await setup();
  writeFileSync(join(dir, 'shared-agent'), 'x');
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => { calls.push(String(url)); return new Response('{}'); });
  expect((await tool('get_agent_prompt')).data).toMatchObject({ shared_default_agent: true });
  expect((await tool('update_agent_prompt', { prompt: 'x' })).data).toMatchObject({ changed: false });
  expect(calls.filter(u => u.includes('elevenlabs'))).toEqual([]);
});

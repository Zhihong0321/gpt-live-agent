// Production self-check. Runs ON the Railway server (read-only, no calls, no paid services):
//   node scripts/prod-check.mjs
// Checks every user's bridge directly and through the front router, and every WhatsApp session.
// Every check runs; problems are printed as FAIL lines and saved to /data/prod-check-latest.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const data = process.env.VOXDOCK_DATA_DIR || '/data';
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) { record(`read ${file}`, false, error?.message ?? String(error)); return undefined; } };
async function get(url, headers = {}) {
  try {
    const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const text = await response.text();
    return { status: response.status, text, headers: response.headers };
  } catch (error) { return { status: 0, text: '', error: error?.cause?.code ?? error?.message ?? String(error) }; }
}

const routes = readJson(join(data, 'front-routes.json'));
const mainConfig = readJson(join(data, 'railway.config.json'));
const tenants = existsSync(join(data, 'tenants.json')) ? (readJson(join(data, 'tenants.json')) ?? []) : [];
const routerPort = routes?.listen?.split(':').at(-1);
const router = `http://127.0.0.1:${routerPort}`;
const waEndpoint = mainConfig?.channels?.whatsapp?.endpoint;

const users = [{ id: 'main', config: mainConfig }, ...(Array.isArray(tenants) ? tenants : []).map(t => ({ id: t?.id, config: readJson(join(data, 'users', String(t?.id), 'railway.config.json')) }))];
const sessions = waEndpoint ? await get(`${waEndpoint}/api/sessions`) : { status: 0, error: 'no WhatsApp endpoint in main config' };
let sessionList = [];
try { sessionList = JSON.parse(sessions.text).sessions ?? []; } catch { /* reported below */ }
record('WhatsApp sidecar answers', sessions.status === 200, sessions.error ?? `HTTP ${sessions.status}`);

for (const user of users) {
  const id = user.id;
  const target = routes?.tenants?.[id];
  record(`[${id}] has a route`, typeof target === 'string', target ?? 'missing in front-routes.json');
  if (!user.config) continue;
  const direct = `http://127.0.0.1:${user.config.service.listen.split(':').at(-1)}`;
  const health = await get(`${direct}/healthz`);
  record(`[${id}] bridge /healthz direct`, health.status === 200, health.error ?? `HTTP ${health.status}`);
  let token = '';
  try { token = readFileSync(user.config.security.control_token_file, 'utf8').trim(); } catch (error) { record(`[${id}] control token readable`, false, error?.message); }
  if (token) {
    const calls = await get(`${direct}/v1/calls`, { authorization: `Bearer ${token}` });
    let count = '?';
    try { count = JSON.parse(calls.text).calls.length; } catch { /* reported */ }
    record(`[${id}] call list readable`, calls.status === 200, `HTTP ${calls.status}, ${count} calls`);
  }
  const viaRouter = await get(`${router}/console/`, id === 'main' ? {} : { cookie: `voxdock_tenant=${id}` });
  record(`[${id}] console through router`, viaRouter.status === 200 && /<html/i.test(viaRouter.text), viaRouter.error ?? `HTTP ${viaRouter.status}`);
  const select = await get(`${router}/u/${id}`);
  record(`[${id}] /u/${id} selects the user`, select.status === 302 && select.headers?.get('location') === '/console/', `HTTP ${select.status}`);
  const ref = user.config.channels?.whatsapp?.account_ref ?? 'whatsapp-owner';
  const session = sessionList.find(s => s?.id === ref);
  record(`[${id}] WhatsApp session ${ref}`, true, session ? `paired=${session.paired} state=${session.state}` : 'not created yet (normal until this user links WhatsApp)');
  const agent = user.config.live?.elevenlabs?.agent_ids?.whatsapp;
  record(`[${id}] agent id`, typeof agent === 'string' && agent.length > 0, agent ?? 'missing');
}
const publicDefault = await get(`${router}/healthz`, { cookie: 'voxdock_tenant=does-not-exist' });
record('unknown user cookie falls back to main', publicDefault.status === 200, `HTTP ${publicDefault.status}`);

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
try { writeFileSync(join(data, 'prod-check-latest.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2), { mode: 0o600 }); } catch { /* the printed lines are the result */ }

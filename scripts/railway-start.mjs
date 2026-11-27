import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { MAIN, readTenants, tenantConfig, tenantDir } from './tenants.mjs';

// One instance owns the volume and its linked WhatsApp identity.
process.umask(0o077);
const data = process.env.VOXDOCK_DATA_DIR || '/data';
const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
const origin = process.env.VOXDOCK_PUBLIC_ORIGIN || (domain && `https://${domain}`);
const port = Number(process.env.PORT || 8787);
const waPort = port === 18081 ? 28081 : 18081;
const backendPort = port === 18082 ? 28082 : 18082;
// Each user's bridge listens on loopback; the front router owns the public port.
const bridgeBase = port >= 18100 && port < 18400 ? 28100 : 18100;
if (!origin || !process.env.ELEVENLABS_API_KEY || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Set ELEVENLABS_API_KEY and assign a Railway public domain (or set VOXDOCK_PUBLIC_ORIGIN).');
  process.exit(1);
}
mkdirSync(data, { recursive: true, mode: 0o700 });
function secret(name) {
  const path = join(data, name);
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  return path;
}
const control = secret('control.token');
const media = secret('wacalls-media');
const request = secret('backend-request-token');
const signing = secret('backend-event-signing-key');
const liveKey = join(data, 'elevenlabs-api-key');
writeFileSync(liveKey, process.env.ELEVENLABS_API_KEY, { mode: 0o600 });
chmodSync(liveKey, 0o600);
// ElevenLabs agents (one per phone audio rate); override with these variables if the agents are recreated.
const agents = {
  telegram: process.env.ELEVENLABS_AGENT_ID_TELEGRAM || 'agent_7801m7ktzjeheh9axna9597gqwq2',
  whatsapp: process.env.ELEVENLABS_AGENT_ID_WHATSAPP || 'agent_0801m7ktz1p3f4w9mvpmr17v02rm',
};
const config = {
  schema_version: 1,
  service: { listen: `127.0.0.1:${bridgeBase}`, data_dir: data },
  security: { control_token_file: control },
  console: { enabled: true, public_origin: origin },
  // 60 minutes of talk a day caps website-visitor spend (about $9 at current rates).
  calling: { enabled: false, max_call_seconds: 300, daily_live_seconds: 3600 },
  visitor_calls: { max_per_number_per_day: 2 },
  channels: { telegram: { enabled: false }, whatsapp: { enabled: false, endpoint: `http://127.0.0.1:${waPort}`, media_token_file: media } },
  targets: [],
  live: { api_key_file: liveKey, elevenlabs: { agent_ids: agents }, language: 'en', instructions: 'Persona, voice and language are set on the ElevenLabs agent.' },
  backend: { id: 'test', base_url: `http://127.0.0.1:${backendPort}`, request_token_file: request, event_signing_key_file: signing },
  records: { transcript_retention_days: 0 },
  timezone: 'Asia/Kuala_Lumpur',
};
const configPath = join(data, 'railway.config.json');
writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
const env = { ...process.env, WACALLS_MEDIA_SECRET_FILE: media, BACKEND_REQUEST_TOKEN_FILE: request, BACKEND_EVENT_SIGNING_KEY_FILE: signing, EXAMPLE_BACKEND_DATABASE: join(data, 'backend.sqlite'), EXAMPLE_BACKEND_PORT: String(backendPort), EXAMPLE_BACKEND_MODE: 'simulation' };
delete env.ELEVENLABS_API_KEY;
// Users: main always, plus every entry in /data/tenants.json (added with scripts/tenant-add.mjs).
const tenantsFile = join(data, 'tenants.json');
const routesFile = join(data, 'front-routes.json');
const routes = { listen: `0.0.0.0:${port}`, default: MAIN, tenants: { [MAIN]: `http://127.0.0.1:${bridgeBase}` } };
const writeRoutes = () => {
  try { writeFileSync(routesFile, JSON.stringify(routes, null, 2), { mode: 0o600 }); }
  catch (error) { console.error(`tenants: cannot write ${routesFile}: ${error?.message ?? error}`); }
};
writeRoutes();
const bridge = file => spawn('node', ['--import', 'tsx', 'apps/bridge/src/cli.ts', 'serve', '--config', file], { env, stdio: 'inherit' });
const children = [
  spawn('/opt/wacalls/wacalls-server', ['-addr', `127.0.0.1:${waPort}`, '-db', join(data, 'wacalls.db'), '-static', '/opt/wacalls/client', '-max-calls-per-session', '1'], { env, stdio: 'inherit' }),
  spawn('node', ['--import', 'tsx', 'examples/backend/src/cli.ts'], { env, stdio: 'inherit' }),
  bridge(configPath),
  spawn('node', ['scripts/front-router.mjs', routesFile], { env, stdio: 'inherit' }),
];
let stopping = false;
const extra = new Map(); // id -> { port, child }
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  for (const { child } of extra.values()) child?.kill('SIGTERM');
  setTimeout(() => process.exit(code), 3000).unref();
}
for (const child of children) {
  child.on('error', () => stop(1));
  child.on('exit', () => stop(1));
}
// A user's bridge that stops is restarted on its own; it never takes the other users down.
function runTenant(id, file) {
  if (stopping) return;
  const entry = extra.get(id);
  const child = bridge(file);
  entry.child = child;
  let restarted = false;
  const startedAt = Date.now();
  const again = reason => {
    if (restarted || stopping) return;
    restarted = true;
    // Quick repeated failures wait longer (5 s up to 60 s) so the log stays readable.
    entry.failures = Date.now() - startedAt < 60000 ? (entry.failures ?? 0) + 1 : 1;
    const wait = Math.min(60, 5 * 2 ** (entry.failures - 1));
    console.error(`tenants: bridge for "${id}" stopped (${reason}), restart ${entry.failures} in ${wait} s`);
    setTimeout(() => runTenant(id, file), wait * 1000).unref();
  };
  child.on('error', error => again(error?.message ?? 'spawn error'));
  child.on('exit', code => again(`exit ${code}`));
}
let nextPort = bridgeBase + 1;
function startNewTenants() {
  for (const tenant of readTenants(tenantsFile)) {
    if (extra.has(tenant.id)) continue;
    try {
      const dir = tenantDir(data, tenant.id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tenantPort = nextPort++;
      const tenantControl = join(dir, 'control.token');
      if (!existsSync(tenantControl)) writeFileSync(tenantControl, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
      chmodSync(tenantControl, 0o600);
      // Marks a user without their own agent: the MCP never reads or changes the shared default agent.
      const sharedMarker = join(dir, 'shared-agent');
      if (tenant.agent_id_whatsapp) rmSync(sharedMarker, { force: true });
      else writeFileSync(sharedMarker, 'This user shares the default agent.\n', { mode: 0o600 });
      const file = join(dir, 'railway.config.json');
      writeFileSync(file, JSON.stringify(tenantConfig(config, tenant, { listen: `127.0.0.1:${tenantPort}`, dataDir: dir, controlTokenFile: tenantControl }), null, 2), { mode: 0o600 });
      extra.set(tenant.id, { port: tenantPort, child: undefined });
      routes.tenants[tenant.id] = `http://127.0.0.1:${tenantPort}`;
      writeRoutes();
      console.error(`tenants: starting "${tenant.id}" on port ${tenantPort}${tenant.agent_id_whatsapp ? '' : ' (using the default agent)'}`);
      runTenant(tenant.id, file);
    } catch (error) {
      console.error(`tenants: could not start "${tenant.id}", will retry: ${error?.message ?? error}`);
      extra.delete(tenant.id);
    }
  }
}
startNewTenants();
setInterval(startNewTenants, 10000).unref();
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));

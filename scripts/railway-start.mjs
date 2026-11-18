import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

// One instance owns the volume and its linked WhatsApp identity.
process.umask(0o077);
const data = process.env.VOXDOCK_DATA_DIR || '/data';
const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
const origin = process.env.VOXDOCK_PUBLIC_ORIGIN || (domain && `https://${domain}`);
const port = Number(process.env.PORT || 8787);
const waPort = port === 18081 ? 28081 : 18081;
const backendPort = port === 18082 ? 28082 : 18082;
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
  service: { listen: `0.0.0.0:${port}`, data_dir: data },
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
const children = [
  spawn('/opt/wacalls/wacalls-server', ['-addr', `127.0.0.1:${waPort}`, '-db', join(data, 'wacalls.db'), '-static', '/opt/wacalls/client', '-max-calls-per-session', '1'], { env, stdio: 'inherit' }),
  spawn('node', ['--import', 'tsx', 'examples/backend/src/cli.ts'], { env, stdio: 'inherit' }),
  spawn('node', ['--import', 'tsx', 'apps/bridge/src/cli.ts', 'serve', '--config', configPath], { env, stdio: 'inherit' }),
];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 3000).unref();
}
for (const child of children) {
  child.on('error', () => stop(1));
  child.on('exit', () => stop(1));
}
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));

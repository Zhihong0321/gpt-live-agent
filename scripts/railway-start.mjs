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
if (!origin || !process.env.OPENAI_API_KEY || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Set OPENAI_API_KEY and assign a Railway public domain (or set VOXDOCK_PUBLIC_ORIGIN).');
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
const openai = join(data, 'openai-api-key');
writeFileSync(openai, process.env.OPENAI_API_KEY, { mode: 0o600 });
chmodSync(openai, 0o600);
const config = {
  schema_version: 1,
  service: { listen: `0.0.0.0:${port}`, data_dir: data },
  security: { control_token_file: control },
  console: { enabled: true, public_origin: origin },
  calling: { enabled: false, max_call_seconds: 300, daily_live_seconds: 1200 },
  channels: { telegram: { enabled: false }, whatsapp: { enabled: false, endpoint: 'http://127.0.0.1:8080', media_token_file: media } },
  targets: [],
  live: { api_key_file: openai, language: 'en', instructions: 'Speak naturally and match the caller’s language, including mixed languages. Keep replies short. This is a voice quality test; do not invent a product. Avoid delegating tasks.' },
  backend: { id: 'test', base_url: 'http://127.0.0.1:8090', request_token_file: request, event_signing_key_file: signing },
  records: { transcript_retention_days: 0 },
  timezone: 'Asia/Kuala_Lumpur',
};
const configPath = join(data, 'railway.config.json');
writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
const env = { ...process.env, WACALLS_MEDIA_SECRET_FILE: media, BACKEND_REQUEST_TOKEN_FILE: request, BACKEND_EVENT_SIGNING_KEY_FILE: signing, EXAMPLE_BACKEND_DATABASE: join(data, 'backend.sqlite'), EXAMPLE_BACKEND_MODE: 'simulation' };
delete env.OPENAI_API_KEY;
const children = [
  spawn('/opt/wacalls/wacalls-server', ['-addr', '127.0.0.1:8080', '-db', join(data, 'wacalls.db'), '-static', '/opt/wacalls/client', '-max-calls-per-session', '1'], { env, stdio: 'inherit' }),
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

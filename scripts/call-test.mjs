import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const data = process.env.VOXDOCK_DATA_DIR || '/data';
const config = JSON.parse(readFileSync(`${data}/railway.config.json`, 'utf8'));
const port = config.service.listen.split(':').at(-1);
const token = readFileSync(config.security.control_token_file, 'utf8').trim();
const base = `http://127.0.0.1:${port}`;
async function request(path, options = {}) {
  const response = await fetch(base + path, { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body;
}
try {
  const targets = await request('/v1/targets');
  const target = targets.find((item) => item.channel === 'whatsapp' && item.enabled);
  if (!target) throw new Error('No enabled WhatsApp recipient. Complete WhatsApp pairing and recipient verification in the console.');
  const id = randomUUID();
  const result = await request('/v1/calls', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': id },
    body: JSON.stringify({ target_id: target.id, context_ref: 'voice-test', correlation_ref: id, expires_at: new Date(Date.now() + 120000).toISOString() }),
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

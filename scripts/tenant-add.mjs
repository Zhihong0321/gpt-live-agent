// Admin only. Adds a user, or changes a user's ElevenLabs agent id. Run on the server (Railway SSH):
//   node scripts/tenant-add.mjs <id> [agent_id]
// The running service starts a new user's bridge within about 10 seconds. No restart is needed.
// A changed agent id for an existing user applies after the next service restart.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAIN, TENANT_ID, tenantDir } from './tenants.mjs';

const [id, agent] = process.argv.slice(2);
const data = process.env.VOXDOCK_DATA_DIR || '/data';
const file = join(data, 'tenants.json');
if (!id || !TENANT_ID.test(id)) { console.error('Usage: node scripts/tenant-add.mjs <id> [agent_id]   (id: lowercase letters, digits, dashes)'); process.exit(2); }
if (id === MAIN) { console.error('"main" is the existing owner account and is always present.'); process.exit(2); }
if (agent !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(agent)) { console.error('agent_id must look like agent_0801m7...'); process.exit(2); }

let list = [];
if (existsSync(file)) {
  try { list = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { console.error(`${file} is not valid JSON; fix it by hand first: ${error.message}`); process.exit(1); }
  if (!Array.isArray(list)) { console.error(`${file} must hold a list; fix it by hand first.`); process.exit(1); }
}
const existing = list.find(entry => entry?.id === id);
if (existing) {
  if (agent !== undefined) existing.agent_id_whatsapp = agent;
} else list.push(agent !== undefined ? { id, agent_id_whatsapp: agent } : { id });
writeFileSync(file, JSON.stringify(list, null, 2), { mode: 0o600 });

const domain = process.env.VOXDOCK_PUBLIC_ORIGIN || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '<your-domain>');
if (existing) console.log(`Updated "${id}". ${agent !== undefined ? 'The new agent id applies after the next service restart.' : 'Nothing changed.'}`);
else console.log(`Added "${id}"${agent ? '' : ' (default agent until an agent id is set)'}.
Sign-in page: ${domain}/u/${id}
First login (ready about 10 seconds after this): cat ${join(tenantDir(data, id), 'bootstrap-credentials.txt')}`);

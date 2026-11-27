// Users (tenants) of one Railway container. "main" is today's single user and always exists:
// it keeps /data and its config exactly as before. Every other user gets /data/users/<id>/ with
// its own login, call database, WhatsApp session and agent id, run by its own copy of the bridge.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAIN = 'main';
export const TENANT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

// Never throws: a bad file or a bad entry is logged and skipped, the other users still start.
export function readTenants(file, log = console.error) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); }
  catch (error) {
    if (error?.code !== 'ENOENT') log(`tenants: cannot read ${file}: ${error?.message ?? error}`);
    return [];
  }
  let list;
  try { list = JSON.parse(raw); }
  catch (error) { log(`tenants: ${file} is not valid JSON, no extra users started: ${error?.message ?? error}`); return []; }
  if (!Array.isArray(list)) { log(`tenants: ${file} must hold a list, no extra users started`); return []; }
  const seen = new Set([MAIN]);
  const tenants = [];
  list.forEach((entry, index) => {
    const id = entry?.id;
    if (typeof id !== 'string' || !TENANT_ID.test(id)) { log(`tenants: entry ${index + 1} skipped, bad id`); return; }
    if (seen.has(id)) { log(`tenants: entry ${index + 1} skipped, id "${id}" is reserved or repeated`); return; }
    seen.add(id);
    const agent = entry.agent_id_whatsapp;
    const tenant = { id };
    if (typeof agent === 'string' && AGENT_ID.test(agent)) tenant.agent_id_whatsapp = agent;
    else if (agent !== undefined && agent !== null && agent !== '') log(`tenants: "${id}" agent id is not valid, using the default agent`);
    tenants.push(tenant);
  });
  return tenants;
}

// The new user's config is main's config with only these fields changed.
export function tenantConfig(mainConfig, tenant, { listen, dataDir, controlTokenFile }) {
  const config = structuredClone(mainConfig);
  config.service = { ...config.service, listen, data_dir: dataDir };
  config.security = { ...config.security, control_token_file: controlTokenFile };
  config.channels.whatsapp = { ...config.channels.whatsapp, account_ref: `wa-${tenant.id}` };
  if (tenant.agent_id_whatsapp)
    config.live.elevenlabs = { ...config.live.elevenlabs, agent_ids: { ...config.live.elevenlabs.agent_ids, whatsapp: tenant.agent_id_whatsapp } };
  return config;
}

export const tenantDir = (data, id) => join(data, 'users', id);

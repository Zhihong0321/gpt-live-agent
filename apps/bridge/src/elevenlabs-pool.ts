import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// ElevenLabs key pool. Key 1 is the key the service already has (Railway); extra keys are added on /admin.
// Each extra key is another ElevenLabs account, so it gets its own copy of every agent in use.
// New calls use the first key, in order, that is healthy and above the credit floor; when none is,
// they use key 1 exactly as before. Reading the pool never throws and never stops a call.
const API = 'https://api.elevenlabs.io';

export interface KeyCheck { ok: boolean; checked_at: string; tier?: string; used?: number; limit?: number; remaining?: number; reset_at?: string | null; error?: string }
export interface AgentCopy { agent_id: string | null; source_hash: string | null; synced_at: string | null; problem: string | null }
export interface PoolKey { id: string; label: string; key: string; added_at: string; check?: KeyCheck; copies: Record<string, AgentCopy> }
export interface Pool { min_credits: number; primary_check?: KeyCheck; keys: PoolKey[]; last_cycle?: string; choice?: string }
export interface LiveChoice { apiKey: string; agentId: string; key: string }

const empty = (): Pool => ({ min_credits: 5000, keys: [] });
export const last4 = (key: string) => (key.length > 4 ? `…${key.slice(-4)}` : '…');

/** The pool lives in the main data folder; a user's bridge (data folder /data/users/<id>) looks two levels up. */
export function poolFileFor(dataDirectory: string): string {
  return basename(dirname(dataDirectory)) === 'users' ? join(dirname(dirname(dataDirectory)), 'elevenlabs-pool.json') : join(dataDirectory, 'elevenlabs-pool.json');
}
export const isMainData = (dataDirectory: string) => basename(dirname(dataDirectory)) !== 'users';

export function readPool(file: string, log: (line: string) => void = () => {}): Pool {
  try {
    if (!existsSync(file)) return empty();
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const pool = empty();
    if (Number.isFinite(raw?.min_credits) && raw.min_credits >= 0) pool.min_credits = raw.min_credits;
    if (raw?.primary_check && typeof raw.primary_check === 'object') pool.primary_check = raw.primary_check;
    if (typeof raw?.last_cycle === 'string') pool.last_cycle = raw.last_cycle;
    if (typeof raw?.choice === 'string') pool.choice = raw.choice;
    for (const k of Array.isArray(raw?.keys) ? raw.keys : []) {
      if (typeof k?.id !== 'string' || typeof k?.key !== 'string' || !k.key) { log('elevenlabs pool: one key entry skipped, it is incomplete'); continue; }
      pool.keys.push({ id: k.id, label: typeof k.label === 'string' ? k.label : k.id, key: k.key, added_at: String(k.added_at ?? ''),
        ...(k.check && typeof k.check === 'object' ? { check: k.check } : {}), copies: k.copies && typeof k.copies === 'object' ? k.copies : {} });
    }
    return pool;
  } catch (error) {
    log(`elevenlabs pool: cannot read ${file}, using key 1 only: ${(error as Error)?.message ?? error}`);
    return empty();
  }
}
export function writePool(file: string, pool: Pool): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(pool, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

const usable = (check: KeyCheck | undefined, floor: number) => !!check?.ok && (check.remaining ?? 0) >= floor;

/** Key and agent for one new call. Unchecked key 1 counts as usable, as it always was. */
export function chooseLive(pool: Pool, sourceAgentId: string, primaryKey: string): LiveChoice & { reason: string } {
  if (!pool.primary_check || usable(pool.primary_check, pool.min_credits)) return { apiKey: primaryKey, agentId: sourceAgentId, key: 'key 1', reason: 'key 1 ok' };
  for (const k of pool.keys) {
    const copy = k.copies[sourceAgentId];
    if (usable(k.check, pool.min_credits) && copy?.agent_id && !copy.problem) return { apiKey: k.key, agentId: copy.agent_id, key: k.label, reason: 'key 1 low or failing' };
  }
  return { apiKey: primaryKey, agentId: sourceAgentId, key: 'key 1', reason: 'no other key is ready; key 1 used anyway' };
}

/** For the call runtime: never throws; any problem means key 1 and the original agent. */
export function livePicker(dataDirectory: string, log: (line: string) => void) {
  const file = poolFileFor(dataDirectory);
  return (sourceAgentId: string, primaryKey: string): LiveChoice => {
    try {
      const choice = chooseLive(readPool(file, log), sourceAgentId, primaryKey);
      if (choice.key !== 'key 1' || choice.reason !== 'key 1 ok') log(`elevenlabs pool: call uses ${choice.key} (${choice.reason})`);
      return choice;
    } catch (error) {
      log(`elevenlabs pool: choice failed, using key 1: ${(error as Error)?.message ?? error}`);
      return { apiKey: primaryKey, agentId: sourceAgentId, key: 'key 1' };
    }
  };
}

type Fetch = typeof fetch;
async function call(fetcher: Fetch, key: string, method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const response = await fetcher(`${API}${path}`, { method, signal: AbortSignal.timeout(20000),
    headers: { 'xi-api-key': key, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let json: any = undefined; try { json = JSON.parse(text); } catch { /* text only */ }
  return { ok: response.ok, status: response.status, json, text };
}

export async function checkKey(key: string, fetcher: Fetch = fetch): Promise<KeyCheck> {
  const checked_at = new Date().toISOString();
  try {
    const r = await call(fetcher, key, 'GET', '/v1/user/subscription');
    if (!r.ok) return { ok: false, checked_at, error: `HTTP ${r.status}: ${r.text.slice(0, 160)}` };
    const used = Number(r.json?.character_count ?? 0), limit = Number(r.json?.character_limit ?? 0);
    const reset = Number(r.json?.next_character_count_reset_unix);
    return { ok: true, checked_at, tier: String(r.json?.tier ?? ''), used, limit, remaining: Math.max(0, limit - used),
      reset_at: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null };
  } catch (error) { return { ok: false, checked_at, error: String((error as Error)?.message ?? error).slice(0, 160) }; }
}

/** Copies (or refreshes) one agent into another account. Returns the copy record with any problem written on it. */
export async function syncAgent(primaryKey: string, sourceAgentId: string, target: PoolKey, fetcher: Fetch = fetch): Promise<AgentCopy> {
  const before = target.copies[sourceAgentId] ?? { agent_id: null, source_hash: null, synced_at: null, problem: null };
  try {
    const source = await call(fetcher, primaryKey, 'GET', `/v1/convai/agents/${encodeURIComponent(sourceAgentId)}`);
    if (!source.ok) return { ...before, problem: `cannot read the original agent: HTTP ${source.status}` };
    const config = source.json?.conversation_config ?? {};
    const hash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
    if (before.agent_id && before.source_hash === hash && !before.problem) return before;
    let agentId = before.agent_id;
    if (agentId) {
      const patched = await call(fetcher, target.key, 'PATCH', `/v1/convai/agents/${encodeURIComponent(agentId)}`, { conversation_config: config });
      if (patched.status === 404) agentId = null;
      else if (!patched.ok) return { ...before, problem: `update failed: HTTP ${patched.status}: ${patched.text.slice(0, 160)}` };
    }
    if (!agentId) {
      const created = await call(fetcher, target.key, 'POST', '/v1/convai/agents/create', { name: `${source.json?.name ?? 'VoxDock agent'} (copy)`, conversation_config: config });
      if (!created.ok || typeof created.json?.agent_id !== 'string') return { ...before, problem: `copy failed: HTTP ${created.status}: ${created.text.slice(0, 160)}` };
      agentId = created.json.agent_id;
    }
    const voice = config?.tts?.voice_id;
    if (typeof voice === 'string' && voice) {
      const v = await call(fetcher, target.key, 'GET', `/v1/voices/${encodeURIComponent(voice)}`);
      if (!v.ok) return { agent_id: agentId, source_hash: hash, synced_at: new Date().toISOString(), problem: `voice ${voice} is not in this account (add it from the Voice Library); this key is not used until fixed` };
    }
    return { agent_id: agentId, source_hash: hash, synced_at: new Date().toISOString(), problem: null };
  } catch (error) { return { ...before, problem: `sync failed: ${String((error as Error)?.message ?? error).slice(0, 160)}` }; }
}

/** Agents in use: main's WhatsApp agent plus every user's own agent. */
export function agentsInUse(mainData: string, mainAgent: string | undefined): string[] {
  const found = new Set<string>();
  if (mainAgent) found.add(mainAgent);
  try {
    const users = join(mainData, 'users');
    for (const id of existsSync(users) ? readdirSync(users) : []) {
      try { const c = JSON.parse(readFileSync(join(users, id, 'railway.config.json'), 'utf8')); const a = c?.live?.elevenlabs?.agent_ids?.whatsapp; if (typeof a === 'string' && a) found.add(a); }
      catch { /* a user without a readable config is skipped this round */ }
    }
  } catch { /* main agent only */ }
  return [...found];
}

/** One monitor round: check every key, refresh agent copies, record which key new calls will use. */
export async function runCycle(file: string, primaryKey: string, sources: string[], log: (line: string) => void, fetcher: Fetch = fetch): Promise<Pool> {
  const pool = readPool(file, log);
  pool.primary_check = await checkKey(primaryKey, fetcher);
  for (const k of pool.keys) {
    k.check = await checkKey(k.key, fetcher);
    for (const source of sources) k.copies[source] = await syncAgent(primaryKey, source, k, fetcher);
  }
  pool.last_cycle = new Date().toISOString();
  pool.choice = sources[0] ? chooseLive(pool, sources[0], primaryKey).key : 'key 1';
  // Keys added or removed on the page during this round are kept as the page left them.
  const latest = readPool(file, log);
  const merged: Pool = { ...latest, primary_check: pool.primary_check, last_cycle: pool.last_cycle, choice: pool.choice,
    keys: latest.keys.map(k => { const done = pool.keys.find(p => p.id === k.id && p.key === k.key); return done ? { ...k, ...(done.check ? { check: done.check } : {}), copies: { ...k.copies, ...done.copies } } : k; }) };
  writePool(file, merged);
  return merged;
}

import { createHmac, scrypt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CallStore } from '@voxdock/core';

// Call scripts page: every call's conversation on one page, opened with a shared access key.
// Only a scrypt hash of the key is kept here (this repository is public).
const KEY_SALT = Buffer.from('283c25ec7b6e4d5f6e609d6bba4cbbd2', 'hex');
const KEY_HASH = Buffer.from('737b8f26117591a62c627311a5ce97f256063332f831d2f7e8d0ea2cfee10d67', 'hex');
const COOKIE = 'voxdock_scripts';
const COOKIE_DAYS = 30;
const MAX_CALLS = 5000;

const escape = (text: unknown) => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface ScriptsKey { salt: Buffer; hash: Buffer }
function keyMatches(given: unknown, key: ScriptsKey): Promise<boolean> {
  if (typeof given !== 'string' || !given || given.length > 200) return Promise.resolve(false);
  return new Promise(resolve => scrypt(given, key.salt, 32, (error, derived) =>
    resolve(!error && derived.length === key.hash.length && timingSafeEqual(derived, key.hash))));
}

const cookieMac = (controlToken: string, expires: number) =>
  createHmac('sha256', controlToken).update(`voxdock-scripts-v1:${expires}`).digest('base64url');

function hasAccess(request: FastifyRequest, controlToken: string): boolean {
  try {
    const raw = (request.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`));
    if (!raw) return false;
    const [expiresText, mac] = raw.slice(COOKIE.length + 1).split('.');
    const expires = Number(expiresText);
    if (!mac || !Number.isFinite(expires) || expires * 1000 < Date.now()) return false;
    const expected = Buffer.from(cookieMac(controlToken, expires)); const given = Buffer.from(mac);
    return given.length === expected.length && timingSafeEqual(given, expected);
  } catch { return false; }
}

type Speaker = 'user' | 'assistant' | string;
interface Script {
  id: string; started: string; state: string; direction: string; seconds: number | null;
  who: string[]; turns: Array<{ speaker: Speaker; text: string; final: boolean }>; note: string | null;
}

const availabilityNote: Record<string, string> = {
  disabled: 'Conversation capture was turned off for this call.',
  expired: 'Conversation text for this call has expired.',
  empty: 'No conversation was recorded for this call.',
};

// Never throws: a call that fails to read is still listed, with the problem written on it.
function collect(store: CallStore): { scripts: Script[]; total: number; problem: string | null } {
  const scripts: Script[] = []; let total = 0; let problem: string | null = null;
  try {
    let cursor: string | undefined;
    do {
      const page = store.consoleCalls({ limit: 100, ...(cursor ? { cursor } : {}) });
      total = page?.total ?? total;
      for (const item of page?.items ?? []) {
        if (scripts.length >= MAX_CALLS) break;
        const id = item?.call?.call_id ?? '';
        const script: Script = { id, started: item?.call?.created_at ?? '', state: item?.call?.state ?? 'unknown',
          direction: item?.call?.direction ?? 'unknown', seconds: item?.duration_seconds ?? null, who: [], turns: [], note: null };
        try {
          const visitor = store.visitorFor(id);
          if (visitor) script.who = [visitor.name, visitor.company, visitor.phone].filter((v): v is string => !!v);
        } catch { /* lead details are optional */ }
        if (!script.who.length) script.who = [item?.call?.target_id ?? 'Unknown'];
        try {
          const conversation = store.consoleConversation(id);
          script.turns = (conversation?.turns ?? []).map(turn => ({ speaker: turn?.speaker ?? '', text: turn?.text ?? '', final: turn?.final !== false }));
          if (!script.turns.length) script.note = availabilityNote[conversation?.availability ?? 'empty'] ?? availabilityNote.empty!;
        } catch { script.note = 'Error: this conversation could not be read.'; }
        scripts.push(script);
      }
      cursor = page?.next_cursor ?? undefined;
    } while (cursor && scripts.length < MAX_CALLS);
    if (total > scripts.length) problem = `Showing the newest ${scripts.length} of ${total} calls.`;
  } catch {
    problem = `Error: the call list could not be fully read. Showing ${scripts.length} calls.`;
  }
  return { scripts, total, problem };
}

const speakerName = (speaker: Speaker) => speaker === 'user' ? 'Customer' : speaker === 'assistant' ? 'Agent' : 'Unknown';
const when = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'Unknown time'; };
const length = (seconds: number | null) => typeof seconds === 'number' ? `${Math.round(seconds)} s` : 'unknown length';

function listHtml(store: CallStore): string {
  const { scripts, problem } = collect(store);
  const head = `<p class="meta">${scripts.length} calls · updated ${escape(when(new Date().toISOString()))}</p>${problem ? `<p class="warn">${escape(problem)}</p>` : ''}`;
  if (!scripts.length) return `${head}<div class="card"><p class="muted">No calls yet.</p></div>`;
  return head + scripts.map(s => `<div class="card"><div class="top"><b>${escape(s.who.join(' · '))}</b>
<span class="muted">${escape(when(s.started))} · ${escape(s.direction)} · ${escape(length(s.seconds))} · ${escape(s.state)}</span></div>
${s.note ? `<p class="muted">${escape(s.note)}</p>` : ''}${s.turns.map(t => `<div class="turn ${t.speaker === 'user' ? 'user' : 'agent'}"><span>${escape(speakerName(t.speaker))}${t.final ? '' : ' (partial)'}</span><p>${escape(t.text)}</p></div>`).join('')}</div>`).join('');
}

function textFile(store: CallStore): string {
  const { scripts, problem } = collect(store);
  const lines = [`Call scripts, exported ${when(new Date().toISOString())}`, ...(problem ? [problem] : []), ''];
  for (const s of scripts) {
    lines.push('='.repeat(60), `Who: ${s.who.join(' · ')}`, `Started: ${when(s.started)}`, `Direction: ${s.direction}  State: ${s.state}  Length: ${length(s.seconds)}`, `Call ID: ${s.id}`, '');
    if (s.note) lines.push(`[${s.note}]`);
    for (const t of s.turns) lines.push(`${speakerName(t.speaker)}${t.final ? '' : ' (partial)'}: ${t.text}`);
    lines.push('');
  }
  return lines.join('\n');
}

const style = `body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:0 auto;padding:24px 16px;background:#f6f7f9;color:#14171a}
h1{font-size:22px;margin:0}.bar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px}
.card{background:#fff;border-radius:12px;padding:16px 18px;margin:14px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.top{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px;margin-bottom:8px}.muted,.meta{color:#68707a;font-size:13px}
.warn{color:#9a5b00;font-size:13px}.turn{border-radius:10px;padding:8px 12px;margin:8px 0;background:#eef6f2}.turn.user{background:#f1f3f5}
.turn span{font-size:12px;font-weight:600;color:#3d4650}.turn p{margin:2px 0 0;white-space:pre-wrap}
a.btn,button{display:inline-block;padding:9px 16px;border:0;border-radius:9px;background:#0b6bcb;color:#fff;font-size:14px;text-decoration:none;cursor:pointer}
input{width:100%;box-sizing:border-box;padding:12px;font-size:16px;border:1px solid #c9ced4;border-radius:9px;margin:12px 0}
@media (prefers-color-scheme:dark){body{background:#111418;color:#e8eaed}.card{background:#1b1f24}.turn{background:#1f2a26}.turn.user{background:#24282d}.turn span{color:#b8c0c8}input{background:#1b1f24;color:#e8eaed;border-color:#3a4048}}`;

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escape(title)}</title><style>${style}</style></head><body>${body}</body></html>`;

const keyForm = page('Call scripts', `<div class="card" style="max-width:380px;margin:60px auto"><h1>Call scripts</h1>
<form id="f"><input id="k" type="password" placeholder="Access key" autocomplete="current-password" autofocus><button type="submit">Open</button></form>
<p id="m" class="warn"></p></div><script>
document.getElementById('f').onsubmit=async e=>{e.preventDefault();const m=document.getElementById('m');m.textContent='';
try{const r=await fetch('/scripts/key',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:document.getElementById('k').value})});
if(r.ok)location.reload();else m.textContent=r.status===401?'Wrong access key.':'Could not check the key. Try again.';}catch{m.textContent='Could not reach the server. Try again.';}};
</script>`);

const fullPage = (store: CallStore) => page('Call scripts', `<div class="bar"><h1>Call scripts</h1><a class="btn" href="/scripts/download.txt">Download all</a></div>
<p class="muted">Every call's conversation, newest first. Updates every 10 seconds.</p><div id="list">${listHtml(store)}</div><script>
setInterval(async()=>{if(document.visibilityState!=='visible')return;try{const r=await fetch('/scripts/list',{cache:'no-store'});
if(r.ok)document.getElementById('list').innerHTML=await r.text();else if(r.status===401)location.reload();}catch{}},10000);
</script>`);

const send = (reply: FastifyReply, code: number, type: string, body: string) =>
  reply.code(code).header('content-type', type).header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
    .header('x-robots-tag', 'noindex').header('x-content-type-options', 'nosniff').send(body);

export function registerScriptsPage(app: FastifyInstance, options: { store: CallStore; controlToken: string; key?: ScriptsKey }) {
  const { store, controlToken } = options;
  const key = options.key ?? { salt: KEY_SALT, hash: KEY_HASH };
  app.get('/scripts', async (request, reply) =>
    send(reply, 200, 'text/html; charset=utf-8', hasAccess(request, controlToken) ? fullPage(store) : keyForm));
  app.post<{ Body: { key?: unknown } }>('/scripts/key', async (request, reply) => {
    if (!(await keyMatches(request.body?.key, key))) return reply.code(401).send({ error: 'wrong_key' });
    const expires = Math.floor(Date.now() / 1000) + COOKIE_DAYS * 86400;
    return reply.code(204).header('set-cookie',
      `${COOKIE}=${expires}.${cookieMac(controlToken, expires)}; Path=/scripts; Max-Age=${COOKIE_DAYS * 86400}; HttpOnly; Secure; SameSite=Strict`).send();
  });
  app.get('/scripts/list', async (request, reply) =>
    hasAccess(request, controlToken) ? send(reply, 200, 'text/html; charset=utf-8', listHtml(store)) : reply.code(401).send({ error: 'unauthorized' }));
  app.get('/scripts/download.txt', async (request, reply) => {
    if (!hasAccess(request, controlToken)) return reply.redirect('/scripts');
    const day = new Date().toISOString().slice(0, 10);
    reply.header('content-disposition', `attachment; filename="call-scripts-${day}.txt"`);
    return send(reply, 200, 'text/plain; charset=utf-8', textFile(store));
  });
}

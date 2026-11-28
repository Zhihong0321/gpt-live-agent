import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ConsoleAccountStore } from './console-account.js';
import { agentsInUse, checkKey, last4, readPool, runCycle, writePool, type Pool } from './elevenlabs-pool.js';

// Admin page at /admin (main bridge only): ElevenLabs keys, their credits, agent copies, and which key new calls use.
// Sign-in is the main console username and password. Keys are only ever shown as their last 4 characters.
export interface KeysAdminOptions {
  account: ConsoleAccountStore;
  controlToken: string;
  publicOrigin: string;
  poolFile: string;
  mainData: string;
  primaryKeyFile: string;
  mainAgent: string | undefined;
  log: (line: string) => void;
}
const COOKIE = 'voxdock_admin';
const HOURS = 12;

export function registerKeysAdmin(app: FastifyInstance, options: KeysAdminOptions) {
  const failures: number[] = [];
  const mac = (expires: number) => createHmac('sha256', options.controlToken).update(`voxdock-admin-v1:${options.account.credentialRevision()}:${expires}`).digest('base64url');
  const signedIn = (request: FastifyRequest) => {
    try {
      const raw = (request.headers.cookie ?? '').split(';').map(p => p.trim()).find(p => p.startsWith(`${COOKIE}=`));
      if (!raw) return false;
      const [expiresText, given] = raw.slice(COOKIE.length + 1).split('.');
      const expires = Number(expiresText);
      if (!given || !Number.isFinite(expires) || expires * 1000 < Date.now()) return false;
      const a = Buffer.from(mac(expires)), b = Buffer.from(given);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch { return false; }
  };
  const sameOrigin = (request: FastifyRequest) => request.headers.origin === options.publicOrigin;
  const guard = (request: FastifyRequest, reply: FastifyReply, mutation: boolean) => {
    if (mutation && !sameOrigin(request)) { reply.code(403).send({ error: 'origin_required' }); return false; }
    if (!signedIn(request)) { reply.code(401).send({ error: 'sign_in_required' }); return false; }
    return true;
  };
  const primaryKey = () => { try { return readFileSync(options.primaryKeyFile, 'utf8').trim(); } catch { return ''; } };
  let running: Promise<Pool> | undefined;
  const cycle = () => {
    if (running) return running;
    running = runCycle(options.poolFile, primaryKey(), agentsInUse(options.mainData, options.mainAgent), options.log)
      .catch(error => { options.log(`elevenlabs pool: monitor round failed: ${(error as Error)?.message ?? error}`); return readPool(options.poolFile, options.log); })
      .finally(() => { running = undefined; });
    return running;
  };
  const view = (pool: Pool) => {
    const key = primaryKey();
    return {
      min_credits: pool.min_credits, last_cycle: pool.last_cycle ?? null, new_calls_use: pool.choice ?? 'key 1', checking: !!running,
      agents: agentsInUse(options.mainData, options.mainAgent),
      keys: [
        { id: 'primary', label: 'Key 1 (Railway ELEVENLABS_API_KEY)', last4: last4(key), primary: true, check: pool.primary_check ?? null, copies: {} },
        ...pool.keys.map(k => ({ id: k.id, label: k.label, last4: last4(k.key), primary: false, added_at: k.added_at, check: k.check ?? null, copies: k.copies })),
      ],
    };
  };
  const timer = setInterval(() => { void cycle(); }, 5 * 60 * 1000);
  const first = setTimeout(() => { void cycle(); }, 30 * 1000);
  timer.unref(); first.unref();
  app.addHook('onClose', async () => { clearInterval(timer); clearTimeout(first); });

  app.get('/admin', async (_request, reply) => reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store')
    .header('x-frame-options', 'DENY').header('referrer-policy', 'no-referrer').send(PAGE));
  app.post<{ Body: { username?: unknown; password?: unknown } }>('/admin/keys/login', async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'origin_required' });
    const now = Date.now();
    while (failures.length && failures[0]! < now - 60000) failures.shift();
    if (failures.length >= 10) return reply.code(429).send({ error: 'too_many_failed_logins' });
    const { username, password } = request.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string' || !(await options.account.authenticate(username, password))) {
      failures.push(now); return reply.code(401).send({ error: 'wrong_login' });
    }
    const expires = Math.floor(now / 1000) + HOURS * 3600;
    const secure = options.publicOrigin.startsWith('https:') ? '; Secure' : '';
    return reply.header('set-cookie', `${COOKIE}=${expires}.${mac(expires)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${HOURS * 3600}${secure}`).send({ ok: true });
  });
  app.post('/admin/keys/logout', async (_request, reply) => reply.header('set-cookie', `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`).send({ ok: true }));
  app.get('/admin/keys/state', async (request, reply) => guard(request, reply, false) ? view(readPool(options.poolFile, options.log)) : reply);
  app.post<{ Body: { label?: unknown; key?: unknown } }>('/admin/keys/add', async (request, reply) => {
    if (!guard(request, reply, true)) return reply;
    const key = typeof request.body?.key === 'string' ? request.body.key.trim() : '';
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(key)) return reply.code(400).send({ error: 'key_format', message: 'Paste the full ElevenLabs API key.' });
    const pool = readPool(options.poolFile, options.log);
    if (key === primaryKey() || pool.keys.some(k => k.key === key)) return reply.code(409).send({ error: 'already_added' });
    const label = typeof request.body?.label === 'string' && request.body.label.trim() ? request.body.label.trim().slice(0, 60) : `Key ${pool.keys.length + 2}`;
    const check = await checkKey(key);
    pool.keys.push({ id: randomBytes(6).toString('hex'), label, key, added_at: new Date().toISOString(), check, copies: {} });
    writePool(options.poolFile, pool);
    void cycle(); // copy the agents into the new account now
    return { ok: true, check };
  });
  app.post<{ Body: { id?: unknown } }>('/admin/keys/remove', async (request, reply) => {
    if (!guard(request, reply, true)) return reply;
    const pool = readPool(options.poolFile, options.log);
    pool.keys = pool.keys.filter(k => k.id !== request.body?.id);
    writePool(options.poolFile, pool);
    return { ok: true };
  });
  app.post<{ Body: { id?: unknown; direction?: unknown } }>('/admin/keys/move', async (request, reply) => {
    if (!guard(request, reply, true)) return reply;
    const pool = readPool(options.poolFile, options.log);
    const i = pool.keys.findIndex(k => k.id === request.body?.id);
    const j = i + (request.body?.direction === 'up' ? -1 : 1);
    if (i >= 0 && j >= 0 && j < pool.keys.length) { const [k] = pool.keys.splice(i, 1); pool.keys.splice(j, 0, k!); writePool(options.poolFile, pool); }
    return { ok: true };
  });
  app.post<{ Body: { min_credits?: unknown } }>('/admin/keys/settings', async (request, reply) => {
    if (!guard(request, reply, true)) return reply;
    const value = Number(request.body?.min_credits);
    if (!Number.isFinite(value) || value < 0) return reply.code(400).send({ error: 'min_credits_number' });
    const pool = readPool(options.poolFile, options.log);
    pool.min_credits = Math.floor(value);
    writePool(options.poolFile, pool);
    return { ok: true };
  });
  app.post('/admin/keys/refresh', async (request, reply) => guard(request, reply, true) ? view(await cycle()) : reply);
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ElevenLabs Keys</title><style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#17212b;--muted:#5d6876;--line:#e0e4ea;--accent:#0b4f8a;--ok:#1d7a46;--bad:#b3261e;--warn:#9a5b00;--bar:#e9edf2}
@media (prefers-color-scheme:dark){:root{--bg:#0f141a;--card:#161d25;--ink:#e6ebf0;--muted:#9aa6b2;--line:#27313c;--accent:#6fb1ec;--ok:#5fcf8f;--bad:#f2867e;--warn:#e6b35c;--bar:#222c37}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{background:var(--accent);color:#fff;padding:18px 16px}header h1{margin:0;font-size:20px}main{max-width:980px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}input{padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);font:inherit;min-width:0}
button{padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);font:inherit;cursor:pointer}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.k{display:grid;grid-template-columns:1fr auto;gap:6px}.muted{color:var(--muted);font-size:13px}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.bar{height:8px;background:var(--bar);border-radius:99px;overflow:hidden;margin:6px 0}.bar span{display:block;height:100%;background:var(--ok)}
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;border:1px solid var(--line)}.use{background:var(--ok);color:#fff;border-color:var(--ok)}
code{font-family:ui-monospace,Consolas,monospace;font-size:13px;word-break:break-all}ul{margin:6px 0;padding-left:18px}#msg{min-height:20px}
</style></head><body><header><h1>ElevenLabs keys</h1></header><main>
<div id="login" class="card" hidden><h2>Sign in (main console account)</h2><div class="row"><input id="u" placeholder="Username" autocomplete="username"><input id="p" type="password" placeholder="Password" autocomplete="current-password"><button class="primary" id="go">Sign in</button></div></div>
<div id="app" hidden>
<div class="card"><div class="row" style="justify-content:space-between"><div><b>New calls use:</b> <span id="use"></span><div class="muted" id="cycle"></div></div>
<div class="row"><button id="refresh">Check now</button><button id="out">Sign out</button></div></div>
<p class="muted">Key 1 is used while its credits are above the floor. When it drops below, new calls move to the next key in this order that is healthy, above the floor and has a working agent copy. If none is ready, key 1 is used anyway. Running calls are never moved.</p>
<div class="row"><label>Credit floor <input id="floor" type="number" min="0" style="width:130px"></label><button id="savefloor">Save</button></div></div>
<div id="keys"></div>
<div class="card"><h3 style="margin-top:0">Add a key (another ElevenLabs account)</h3><div class="row"><input id="label" placeholder="Label, e.g. Account B" style="width:200px"><input id="key" placeholder="API key" style="flex:1;min-width:220px" autocomplete="off"><button class="primary" id="add">Add</button></div>
<p class="muted">After adding, the app copies every agent in use into that account. Copies refresh every 5 minutes, so prompt changes follow automatically.</p></div>
<p id="msg"></p></div></main>
<script>
const $=s=>document.querySelector(s);const esc=t=>String(t??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const fmt=n=>Number(n??0).toLocaleString();const when=t=>t?new Date(t).toLocaleString():'never';
async function api(path,body){const r=await fetch(path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});let j={};try{j=await r.json()}catch{}if(r.status===401&&path!=='/admin/keys/login'){show(false)}return {ok:r.ok,status:r.status,j}}
function show(on){$('#login').hidden=on;$('#app').hidden=!on}
function msg(t,cls){$('#msg').className=cls||'';$('#msg').textContent=t}
function keyCard(k,i,n,use){const c=k.check;const pct=c&&c.limit?Math.round(100*(c.remaining??0)/c.limit):0;
const status=!c?'<span class="warn">not checked yet</span>':c.ok?'<span class="ok">working</span>':'<span class="bad">problem: '+esc(c.error)+'</span>';
const copies=Object.entries(k.copies||{});
return '<div class="card"><div class="k"><div><b>'+esc(k.label)+'</b> <code>'+esc(k.last4)+'</code> '+(use===k.label||(k.primary&&use==='key 1')?'<span class="badge use">new calls use this</span>':'')+'<div class="muted">'+status+(c&&c.tier?' · plan '+esc(c.tier):'')+' · checked '+when(c&&c.checked_at)+'</div></div><div class="row">'+
(k.primary?'':'<button data-up="'+k.id+'" '+(i===1?'disabled':'')+'>↑</button><button data-down="'+k.id+'" '+(i===n-1?'disabled':'')+'>↓</button><button data-rm="'+k.id+'">Remove</button>')+'</div></div>'+
(c&&c.ok?'<div class="bar"><span style="width:'+pct+'%"></span></div><div class="muted">'+fmt(c.remaining)+' credits left of '+fmt(c.limit)+' ('+pct+'%) · used '+fmt(c.used)+(c.reset_at?' · resets '+when(c.reset_at):'')+'</div>':'')+
(k.primary?'<div class="muted">Uses the original agents.</div>':'<div class="muted" style="margin-top:6px">Agent copies:</div><ul>'+(copies.length?copies.map(([src,cp])=>'<li><code>'+esc(src)+'</code> → '+(cp.agent_id?'<code>'+esc(cp.agent_id)+'</code>':'none')+' '+(cp.problem?'<span class="bad">'+esc(cp.problem)+'</span>':'<span class="ok">synced '+when(cp.synced_at)+'</span>')+'</li>').join(''):'<li class="warn">not copied yet (next check)</li>')+'</ul>')+'</div>'}
async function load(){const r=await api('/admin/keys/state');if(!r.ok)return;show(true);const s=r.j;$('#use').textContent=s.new_calls_use;$('#cycle').textContent='Last check: '+when(s.last_cycle)+(s.checking?' (checking now…)':'')+' · agents in use: '+s.agents.length;
if(document.activeElement!==$('#floor'))$('#floor').value=s.min_credits;$('#keys').innerHTML=s.keys.map((k,i)=>keyCard(k,i,s.keys.length,s.new_calls_use)).join('')}
$('#go').onclick=async()=>{const r=await api('/admin/keys/login',{username:$('#u').value,password:$('#p').value});if(r.ok){$('#p').value='';msg('');load()}else msg(r.status===429?'Too many tries, wait one minute.':'Wrong username or password.','bad')};
$('#p').onkeydown=e=>{if(e.key==='Enter')$('#go').click()};
$('#out').onclick=async()=>{await api('/admin/keys/logout',{});show(false)};
$('#refresh').onclick=async()=>{msg('Checking all keys and agent copies…');const r=await api('/admin/keys/refresh',{});msg(r.ok?'Checked.':'Check failed: '+(r.j.error||r.status),r.ok?'ok':'bad');load()};
$('#savefloor').onclick=async()=>{const r=await api('/admin/keys/settings',{min_credits:$('#floor').value});msg(r.ok?'Saved.':'Not saved: '+(r.j.error||r.status),r.ok?'ok':'bad');load()};
$('#add').onclick=async()=>{msg('Adding and checking the key…');const r=await api('/admin/keys/add',{label:$('#label').value,key:$('#key').value});if(r.ok){$('#key').value='';$('#label').value='';msg(r.j.check&&r.j.check.ok?'Added. Copying agents into this account…':'Added, but the key check failed: '+((r.j.check&&r.j.check.error)||''),r.j.check&&r.j.check.ok?'ok':'warn')}else msg('Not added: '+(r.j.message||r.j.error||r.status),'bad');load()};
$('#keys').onclick=async e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.rm){if(!confirm('Remove this key? Its agent copies stay in that ElevenLabs account.'))return;await api('/admin/keys/remove',{id:b.dataset.rm})}else if(b.dataset.up)await api('/admin/keys/move',{id:b.dataset.up,direction:'up'});else if(b.dataset.down)await api('/admin/keys/move',{id:b.dataset.down,direction:'down'});load()};
load().then(()=>{if($('#app').hidden)show(false)});setInterval(()=>{if(!$('#app').hidden)load()},30000);
</script></body></html>`;

// Front router: one public port, one bridge per user on loopback.
// Each request goes to the signed-in user's bridge; no selection means the default user ("main").
// Usage: node scripts/front-router.mjs <routes-file.json>
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const TENANT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const COOKIE = 'voxdock_tenant';
const RELOAD_MS = 5000;
// Only the wait for response headers; generous so slow pairing or QR requests are never cut off.
const UPSTREAM_TIMEOUT_MS = 300000;

function log(line) {
  try { console.log(`front-router: ${line}`); } catch { /* never crash on logging */ }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function parseRoutes(text) {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('routes must be a JSON object');
  const tenants = new Map();
  const source = raw.tenants && typeof raw.tenants === 'object' && !Array.isArray(raw.tenants) ? raw.tenants : {};
  for (const [id, target] of Object.entries(source)) {
    if (!TENANT_ID.test(id)) { log(`routes file problem: ignored bad tenant id ${JSON.stringify(id.slice(0, 40))}`); continue; }
    let url;
    try { url = new URL(String(target)); } catch { log(`routes file problem: ignored bad target for tenant ${id}`); continue; }
    if (url.protocol !== 'http:') { log(`routes file problem: ignored non-http target for tenant ${id}`); continue; }
    tenants.set(id, url);
  }
  const def = typeof raw.default === 'string' && TENANT_ID.test(raw.default) ? raw.default : 'main';
  const listen = typeof raw.listen === 'string' ? raw.listen : undefined;
  return { listen, default: def, tenants };
}

function readCookie(header, name) {
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      try { return decodeURIComponent(value); } catch { return value; }
    }
  }
  return undefined;
}

function sendPage(res, status, title, bodyHtml, extraHeaders = {}) {
  try {
    if (res.headersSent) { res.destroy(); return; }
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${bodyHtml}</body></html>`;
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(html), ...extraHeaders });
    res.end(html);
  } catch {
    try { res.destroy(); } catch { /* ignore */ }
  }
}

function unavailable(res, id) {
  const msg = `User ${id} is starting or unavailable. Try again in a few seconds.`;
  sendPage(res, 502, 'Unavailable', `<p>${escapeHtml(msg)}</p>`);
}

export function createFrontRouter({ routesFile }) {
  let routes = null; // last good routes
  let lastProblem = null;

  function reload() {
    try {
      const next = parseRoutes(readFileSync(routesFile, 'utf8'));
      routes = next;
      if (lastProblem !== null) log('routes file ok again');
      lastProblem = null;
    } catch (error) {
      const message = error && error.message ? String(error.message) : String(error);
      if (message !== lastProblem) log(`routes file problem: ${message}`);
      lastProblem = message;
    }
  }

  function forward(req, res, id, target, path) {
    const headers = { ...req.headers };
    if (headers['x-forwarded-for'] === undefined) headers['x-forwarded-for'] = req.socket?.remoteAddress || 'unknown';
    let failed = false;
    const fail = (why) => {
      if (failed) return;
      failed = true;
      log(`upstream ${id} problem on ${req.method} ${path.split('?')[0]}: ${why}`);
      unavailable(res, id);
    };
    let upstream;
    try {
      upstream = http.request({
        protocol: 'http:',
        hostname: target.hostname,
        port: target.port || 80,
        method: req.method,
        path,
        headers,
        setHost: false,
      });
    } catch (error) {
      fail(error?.message || 'request failed');
      return;
    }
    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => { upstream.destroy(new Error('upstream not responding')); });
    upstream.on('error', (error) => fail(error?.code || error?.message || 'error'));
    upstream.on('response', (up) => {
      // Headers arrived: long streams (event streams, downloads) may stay quiet as long as they like.
      try { upstream.setTimeout(0); } catch { /* ignore */ }
      up.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
      try {
        // rawHeaders keeps multiple set-cookie and original casing.
        const raw = [];
        for (let i = 0; i < up.rawHeaders.length; i += 2) raw.push([up.rawHeaders[i], up.rawHeaders[i + 1]]);
        res.writeHead(up.statusCode || 502, up.statusMessage, raw.flat());
        up.pipe(res);
      } catch (error) {
        fail(error?.message || 'response failed');
        try { up.destroy(); } catch { /* ignore */ }
      }
    });
    req.on('aborted', () => { try { upstream.destroy(); } catch { /* ignore */ } });
    res.on('close', () => { if (!res.writableFinished) { try { upstream.destroy(); } catch { /* ignore */ } } });
    req.pipe(upstream);
  }

  function handle(req, res) {
    req.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
    res.on('error', () => { /* client went away */ });
    const url = typeof req.url === 'string' ? req.url : '/';
    const qIndex = url.indexOf('?');
    const pathname = qIndex < 0 ? url : url.slice(0, qIndex);
    const query = qIndex < 0 ? '' : url.slice(qIndex);
    const current = routes;
    const defaultId = current?.default ?? 'main';

    if (!current) { unavailable(res, defaultId); return; }

    const pick = (id) => current.tenants.get(id);

    // /u/<id>...
    const m = /^\/u\/([^/]*)(\/.*)?$/.exec(pathname);
    if (m) {
      let id = m[1] ?? '';
      try { id = decodeURIComponent(id); } catch { /* keep raw */ }
      const rest = m[2];
      const target = TENANT_ID.test(id) ? pick(id) : undefined;
      if (!target) {
        log(`unknown user in path: ${JSON.stringify(id.slice(0, 40))}`);
        sendPage(res, 404, 'Unknown user', `<p>Unknown user: ${escapeHtml(id)}</p><p><a href="/console/">Go to the console</a></p>`);
        return;
      }
      if (rest === undefined || rest === '/') {
        const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https' ? '; Secure' : '';
        const cookie = id === defaultId
          ? `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
          : `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax${secure}`;
        try {
          res.writeHead(302, { location: '/console/', 'set-cookie': cookie, 'cache-control': 'no-store', 'content-length': 0 });
          res.end();
        } catch { try { res.destroy(); } catch { /* ignore */ } }
        return;
      }
      forward(req, res, id, target, rest + query);
      return;
    }

    // Public customer links: always the default user.
    // The ElevenLabs keys page belongs to the main account.
    const isPublic = pathname.startsWith('/call-link/') || pathname.startsWith('/v1/visitor-calls') || pathname === '/healthz' || pathname === '/admin' || pathname.startsWith('/admin/keys/');
    let id = defaultId;
    if (!isPublic) {
      const chosen = readCookie(req.headers.cookie, COOKIE);
      if (chosen !== undefined && chosen !== '') {
        if (TENANT_ID.test(chosen) && pick(chosen)) id = chosen;
        else log(`unknown user in cookie: ${JSON.stringify(String(chosen).slice(0, 40))}, using ${defaultId}`);
      }
    }
    const target = pick(id);
    if (!target) { log(`no route for user ${id}`); unavailable(res, id); return; }
    forward(req, res, id, target, url);
  }

  const server = http.createServer((req, res) => {
    try { handle(req, res); } catch (error) {
      log(`handler problem: ${error?.message || error}`);
      try { sendPage(res, 502, 'Unavailable', '<p>Temporary problem. Try again in a few seconds.</p>'); } catch { /* ignore */ }
    }
  });
  server.on('clientError', (_error, socket) => { try { socket.destroy(); } catch { /* ignore */ } });
  server.on('connection', (socket) => { socket.on('error', () => { /* ignore */ }); });

  reload();
  const timer = setInterval(reload, RELOAD_MS);
  timer.unref?.();

  function close() {
    clearInterval(timer);
    return new Promise((resolveClose) => {
      try {
        server.close(() => resolveClose());
        server.closeAllConnections?.();
      } catch { resolveClose(); }
    });
  }

  return { server, reload, close, get routes() { return routes; } };
}

function parseListen(listen) {
  const value = typeof listen === 'string' && listen ? listen : '0.0.0.0:8787';
  const idx = value.lastIndexOf(':');
  const host = idx > 0 ? value.slice(0, idx).replace(/^\[|\]$/g, '') : '0.0.0.0';
  const port = Number(idx >= 0 ? value.slice(idx + 1) : value);
  return { host, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 8787 };
}

const isMain = (() => {
  try { return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();

if (isMain) {
  process.on('uncaughtException', (error) => log(`uncaught problem: ${error?.message || error}`));
  process.on('unhandledRejection', (error) => log(`unhandled problem: ${error?.message || error}`));
  const routesFile = process.argv[2];
  if (!routesFile) log('routes file problem: no routes file given (usage: node scripts/front-router.mjs <routes-file.json>)');
  const router = createFrontRouter({ routesFile: routesFile || 'routes.json' });
  const { host, port } = parseListen(router.routes?.listen);
  // Not listening means no site at all: exit so the start script restarts the service.
  router.server.on('error', (error) => { log(`listen problem: ${error?.message || error}`); process.exit(1); });
  router.server.listen(port, host, () => log(`listening on ${host}:${port}`));
}

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Router = { server: http.Server; reload(): void; close(): Promise<void> };
const routerUrl = pathToFileURL(fileURLToPath(new URL("../../../scripts/front-router.mjs", import.meta.url))).href;
const { createFrontRouter } = (await import(routerUrl)) as { createFrontRouter: (o: { routesFile: string }) => Router };

type Seen = { tenant: string; method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

function fakeUpstream(tenant: string, seen: Seen[]): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ tenant, method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      res.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);
      res.setHeader("x-tenant", tenant);
      res.end(`hello from ${tenant}: ${body}`);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const portOf = (s: http.Server) => (s.address() as AddressInfo).port;

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };
function request(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (opts.body !== undefined) {
      // Send in pieces to exercise streaming.
      req.write(opts.body.slice(0, 3));
      setTimeout(() => req.end(opts.body!.slice(3)), 20);
    } else req.end();
  });
}

describe("front router", () => {
  let dir: string;
  let routesFile: string;
  let seen: Seen[];
  let main: http.Server;
  let alice: http.Server;
  let router: Router;
  let port: number;

  const writeRoutes = (tenants: Record<string, string>) =>
    writeFileSync(routesFile, JSON.stringify({ listen: "127.0.0.1:0", default: "main", tenants }));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "front-router-"));
    routesFile = join(dir, "routes.json");
    seen = [];
    main = await fakeUpstream("main", seen);
    alice = await fakeUpstream("alice", seen);
    writeRoutes({ main: `http://127.0.0.1:${portOf(main)}`, alice: `http://127.0.0.1:${portOf(alice)}` });
    router = createFrontRouter({ routesFile });
    await new Promise<void>((r) => router.server.listen(0, "127.0.0.1", () => r()));
    port = portOf(router.server);
  });

  afterEach(async () => {
    await router.close();
    await new Promise((r) => main.close(r));
    await new Promise((r) => alice.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  it("routes to the default tenant without a cookie and keeps Host", async () => {
    const r = await request(port, "/console/", { headers: { host: "app.example.com" } });
    expect(r.status).toBe(200);
    expect(r.headers["x-tenant"]).toBe("main");
    expect(seen[0]?.url).toBe("/console/");
    expect(seen[0]?.headers.host).toBe("app.example.com");
  });

  it("routes by cookie", async () => {
    const r = await request(port, "/v1/status", { headers: { cookie: "other=x; voxdock_tenant=alice" } });
    expect(r.headers["x-tenant"]).toBe("alice");
    expect(seen[0]?.url).toBe("/v1/status");
    expect(seen[0]?.headers.cookie).toBe("other=x; voxdock_tenant=alice");
  });

  it("falls back to default for an unknown cookie value", async () => {
    const r = await request(port, "/v1/status", { headers: { cookie: "voxdock_tenant=bob" } });
    expect(r.status).toBe(200);
    expect(r.headers["x-tenant"]).toBe("main");
  });

  it("/u/alice sets the cookie and redirects", async () => {
    for (const path of ["/u/alice", "/u/alice/"]) {
      const r = await request(port, path);
      expect(r.status).toBe(302);
      expect(r.headers.location).toBe("/console/");
      expect(r.headers["set-cookie"]).toEqual(["voxdock_tenant=alice; Path=/; HttpOnly; SameSite=Lax"]);
    }
    const secure = await request(port, "/u/alice", { headers: { "x-forwarded-proto": "https" } });
    expect(secure.headers["set-cookie"]).toEqual(["voxdock_tenant=alice; Path=/; HttpOnly; SameSite=Lax; Secure"]);
    expect(seen).toHaveLength(0);
  });

  it("/u/main clears the cookie", async () => {
    const r = await request(port, "/u/main");
    expect(r.status).toBe(302);
    expect(r.headers["set-cookie"]?.[0]).toMatch(/^voxdock_tenant=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0$/);
  });

  it("strips the /u/<id> prefix and keeps the query", async () => {
    const r = await request(port, "/u/alice/v1/x?y=1");
    expect(r.headers["x-tenant"]).toBe("alice");
    expect(seen[0]?.url).toBe("/v1/x?y=1");
    expect(r.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("answers 404 for an unknown user path", async () => {
    const r = await request(port, "/u/bob/console/");
    expect(r.status).toBe(404);
    expect(r.body).toContain("Unknown user: bob");
    expect(r.body).toContain('href="/console/"');
    const esc = await request(port, "/u/%3Cx%3E");
    expect(esc.status).toBe(404);
    expect(esc.body).toContain("Unknown user: &lt;x&gt;");
    expect(seen).toHaveLength(0);
  });

  it("public links always go to the default tenant", async () => {
    const cookie = { cookie: "voxdock_tenant=alice" };
    for (const path of ["/call-link/abc", "/v1/visitor-calls", "/v1/visitor-calls/x", "/healthz"]) {
      const r = await request(port, path, { headers: cookie });
      expect(r.headers["x-tenant"]).toBe("main");
    }
  });

  it("passes X-Forwarded-For through or sets it when missing", async () => {
    await request(port, "/a", { headers: { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" } });
    expect(seen[0]?.headers["x-forwarded-for"]).toBe("203.0.113.9");
    expect(seen[0]?.headers["x-forwarded-proto"]).toBe("https");
    await request(port, "/b");
    expect(seen[1]?.headers["x-forwarded-for"]).toMatch(/127\.0\.0\.1/);
  });

  it("preserves multiple set-cookie headers", async () => {
    const r = await request(port, "/console/");
    expect(r.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("answers 502 when the upstream is down", async () => {
    await new Promise((r) => alice.close(r));
    alice = await fakeUpstream("alice", seen); // replacement so afterEach can close it
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", () => r()));
    const deadPort = portOf(dead);
    await new Promise((r) => dead.close(r));
    writeRoutes({ main: `http://127.0.0.1:${portOf(main)}`, alice: `http://127.0.0.1:${deadPort}` });
    router.reload();
    const r = await request(port, "/console/", { headers: { cookie: "voxdock_tenant=alice" } });
    expect(r.status).toBe(502);
    expect(r.body).toContain("User alice is starting or unavailable. Try again in a few seconds.");
  });

  it("keeps the last good routes when the routes file goes bad", async () => {
    writeFileSync(routesFile, "{ not json");
    router.reload();
    const r = await request(port, "/v1/status", { headers: { cookie: "voxdock_tenant=alice" } });
    expect(r.headers["x-tenant"]).toBe("alice");
    rmSync(routesFile);
    router.reload();
    const r2 = await request(port, "/v1/status");
    expect(r2.headers["x-tenant"]).toBe("main");
  });

  it("answers 502 when there were never any good routes", async () => {
    const empty = createFrontRouter({ routesFile: join(dir, "missing.json") });
    await new Promise<void>((r) => empty.server.listen(0, "127.0.0.1", () => r()));
    const r = await request(portOf(empty.server), "/console/");
    expect(r.status).toBe(502);
    expect(r.body).toContain("is starting or unavailable");
    await empty.close();
  });

  it("streams a POST body through", async () => {
    const r = await request(port, "/u/alice/v1/calls", { method: "POST", body: "hello-world", headers: { "content-type": "text/plain" } });
    expect(r.status).toBe(200);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.body).toBe("hello-world");
    expect(r.body).toBe("hello from alice: hello-world");
  });
});

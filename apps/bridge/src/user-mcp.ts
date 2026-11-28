import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BridgeConfig } from '@voxdock/config';
import type { ConsoleAccountStore } from './console-account.js';
import { handleUserMcp, type UserOps } from '../../mcp/src/user-tools.js';

// Remote MCP at /mcp for this bridge's user. The AI agent stores the user's console username and
// password and sends them as HTTP Basic auth; they are checked against the same console login.
export interface UserMcpOptions {
  config: BridgeConfig;
  account: ConsoleAccountStore;
  controlToken: string;
  dataDirectory: string;
  publicOrigin: string;
}
interface PromptVersion { version: number; at: string; by: string; note: string; prompt: string; first_message: string }
const ELEVENLABS = 'https://api.elevenlabs.io/v1/convai/agents';
const SHARED_ANSWER = 'You are using the shared default agent, so its script cannot be read or changed here. Ask the admin for your own agent.';

export function registerUserMcp(app: FastifyInstance, options: UserMcpOptions) {
  const accepted = new Map<string, number>(); // digest of username:password -> credential revision
  const failures: number[] = [];
  const historyFile = join(options.dataDirectory, 'prompt-history.json');

  async function signedIn(request: FastifyRequest): Promise<string | 'too_many' | undefined> {
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Basic ')) return undefined;
    let decoded = '';
    try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return undefined; }
    const split = decoded.indexOf(':');
    if (split < 1) return undefined;
    const username = decoded.slice(0, split); const password = decoded.slice(split + 1);
    const digest = createHash('sha256').update(decoded).digest('hex');
    const revision = options.account.credentialRevision();
    if (accepted.get(digest) === revision) return username;
    const now = Date.now();
    while (failures.length && failures[0]! < now - 60000) failures.shift();
    if (failures.length >= 10) return 'too_many';
    if (await options.account.authenticate(username, password)) { accepted.set(digest, revision); return username; }
    failures.push(now);
    return undefined;
  }

  const agentId = () => options.config.live.elevenlabs?.agent_ids?.whatsapp;
  const shared = () => existsSync(join(options.dataDirectory, 'shared-agent'));
  const apiKey = () => readFileSync(options.config.live.api_key_file ?? '', 'utf8').trim();
  async function elevenlabs(method: 'GET' | 'PATCH', body?: unknown): Promise<Record<string, any>> {
    const id = agentId();
    if (!id) throw Object.assign(new Error('No ElevenLabs agent is set for this user.'), { code: 'no_agent' });
    const response = await fetch(`${ELEVENLABS}/${encodeURIComponent(id)}`, {
      method, signal: AbortSignal.timeout(15000),
      headers: { 'xi-api-key': apiKey(), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw Object.assign(new Error(`ElevenLabs answered HTTP ${response.status}: ${text.slice(0, 200)}`), { code: 'elevenlabs_error' });
    try { return JSON.parse(text); } catch { return {}; }
  }
  const readHistory = (): PromptVersion[] => {
    try { const list = JSON.parse(readFileSync(historyFile, 'utf8')); return Array.isArray(list) ? list : []; }
    catch { return []; }
  };
  const current = async () => {
    const agent = await elevenlabs('GET');
    const a = agent?.conversation_config?.agent ?? {};
    return { prompt: String(a?.prompt?.prompt ?? ''), first_message: String(a?.first_message ?? '') };
  };

  function opsFor(request: FastifyRequest, username: string): UserOps {
    // The original visitor address goes along, so the console's remote-management rule applies as usual.
    const forwarded = request.headers['x-forwarded-for'];
    const headers: Record<string, string> = { authorization: `Bearer ${options.controlToken}`, ...(typeof forwarded === 'string' ? { 'x-forwarded-for': forwarded } : {}) };
    const inject = async (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) => {
      const response = await app.inject({ method, url, headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
      let parsed: unknown = response.body;
      try { parsed = JSON.parse(response.body); } catch { /* keep text */ }
      return { status: response.statusCode, body: parsed };
    };
    const update = async (change: { prompt?: string | undefined; first_message?: string | undefined; note?: string | undefined }) => {
      if (shared()) return { changed: false, reason: SHARED_ANSWER };
      if (change.prompt === undefined && change.first_message === undefined) return { changed: false, reason: 'Nothing to change: give prompt and/or first_message.' };
      const before = await current();
      const history = readHistory();
      const version = (history.at(-1)?.version ?? 0) + 1;
      history.push({ version, at: new Date().toISOString(), by: username, note: change.note ?? '', ...before });
      // A history problem is labelled on the answer; it never stops the change itself.
      let historyProblem: string | undefined;
      try { writeFileSync(historyFile, JSON.stringify(history.slice(-200), null, 2), { mode: 0o600 }); }
      catch (error) { historyProblem = `previous version NOT saved: ${(error as Error)?.message ?? error}`; app.log.error({ err: error }, 'prompt_history_write_failed'); }
      const agent: Record<string, unknown> = {};
      if (change.prompt !== undefined) agent.prompt = { prompt: change.prompt };
      if (change.first_message !== undefined) agent.first_message = change.first_message;
      await elevenlabs('PATCH', { conversation_config: { agent } });
      return historyProblem
        ? { changed: true, previous_version_saved: null, history_problem: historyProblem, note: 'Applies to calls that start from now on. Copies in other ElevenLabs accounts update within 5 minutes.' }
        : { changed: true, previous_version_saved: version, note: 'Applies to calls that start from now on. Copies in other ElevenLabs accounts update within 5 minutes.' };
    };
    return {
      // The user's own sign-in page: /u/<id> for a user folder, the console for the main account.
      consoleUrl: () => basename(dirname(options.dataDirectory)) === 'users' ? `${options.publicOrigin}/u/${basename(options.dataDirectory)}` : `${options.publicOrigin}/console/`,
      request: inject,
      whoami: async () => {
        const settings = await inject('GET', '/v1/console/settings/configuration');
        const s = (settings.body as any)?.settings;
        return { username, agent_id: agentId() ?? null, shared_default_agent: shared(), calling_enabled: s?.calling?.enabled ?? null, whatsapp_enabled: s?.whatsapp?.enabled ?? null };
      },
      getPrompt: async () => shared() ? { shared_default_agent: true, reason: SHARED_ANSWER } : { agent_id: agentId(), ...(await current()) },
      updatePrompt: update,
      promptHistory: async () => ({ versions: readHistory().slice().reverse().map(v => ({ version: v.version, at: v.at, by: v.by, note: v.note, prompt_chars: v.prompt.length, prompt_start: v.prompt.slice(0, 200), first_message: v.first_message })) }),
      restorePrompt: async version => {
        const saved = readHistory().find(v => v.version === version);
        if (!saved) return { changed: false, reason: `Version ${version} is not in the history.` };
        return update({ prompt: saved.prompt, first_message: saved.first_message, note: `restore version ${version}` });
      },
    };
  }

  app.route({
    method: ['GET', 'POST', 'DELETE'], url: '/mcp',
    handler: async (request, reply) => {
      const user = await signedIn(request);
      if (user === 'too_many') return reply.code(429).send({ error: 'too_many_failed_logins', message: 'Wait one minute and try again.' });
      if (!user) return reply.code(401).header('www-authenticate', 'Basic realm="VoxDock MCP"').send({ error: 'unauthorized', message: 'Send the console username and password as HTTP Basic auth.' });
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string' && key !== 'authorization' && key !== 'cookie') headers.set(key, value);
      const web = new Request(`http://localhost${request.url}`, { method: request.method, headers });
      try {
        const result = await handleUserMcp(web, request.method === 'POST' ? request.body : undefined, opsFor(request, user));
        reply.code(result.status);
        for (const [key, value] of result.headers) if (key !== 'content-length') reply.header(key, value);
        return reply.send(result.body);
      } catch (error) {
        request.log.error({ err: error }, 'mcp_request_failed');
        return reply.code(500).send({ error: 'mcp_failed', message: String((error as Error)?.message ?? error).slice(0, 200) });
      }
    },
  });
}

import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

// Remote MCP for one signed-in user. Every tool goes through the bridge's own routes, so the same
// checks and limits apply as in the console. Problems come back as labelled results, never silence.
export interface UserOps {
  request(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  whoami(): Promise<unknown>;
  getPrompt(): Promise<unknown>;
  updatePrompt(change: { prompt?: string | undefined; first_message?: string | undefined; note?: string | undefined }): Promise<unknown>;
  promptHistory(): Promise<unknown>;
  restorePrompt(version: number): Promise<unknown>;
  /** The user's own console address, for setup steps a person must do. */
  consoleUrl(): string;
}

export interface SetupStep { step: number; name: string; done: boolean; who: "you (on your phone, in the console)" | "your AI can do this"; how: string }
export interface SetupStatus { ready_to_call: boolean; console: string; next_step: string; steps: SetupStep[]; problem?: string }

/** Plain setup steps from the same data the console shows. Never throws: a read problem is written on the answer. */
export async function setupStatus(ops: UserOps): Promise<SetupStatus> {
  const link = ops.consoleUrl();
  const [connections, configuration] = await Promise.all([
    ops.request("GET", "/v1/console/connections").catch(() => ({ status: 0, body: undefined })),
    ops.request("GET", "/v1/console/settings/configuration").catch(() => ({ status: 0, body: undefined })),
  ]);
  const channels = isRecord(connections.body) && Array.isArray(connections.body.channels) ? connections.body.channels : [];
  const wa = channels.find((c: unknown) => isRecord(c) && c.channel === "whatsapp") as Record<string, unknown> | undefined;
  const settings = isRecord(configuration.body) && isRecord(configuration.body.settings) ? configuration.body.settings : {};
  const linked = wa?.authenticated === true;
  const paired = Array.isArray(wa?.targets) && wa!.targets.length > 0;
  const waOn = isRecord(settings.whatsapp) && settings.whatsapp.enabled === true;
  const callingOn = isRecord(settings.calling) && settings.calling.enabled === true;
  const ready = wa?.ready === true && callingOn;
  const steps: SetupStep[] = [
    { step: 1, name: "Link the WhatsApp that makes the calls", done: linked, who: "you (on your phone, in the console)",
      how: `Open ${link} and sign in. Connections → Configure WhatsApp → Connect WhatsApp. On the phone whose WhatsApp will make the calls: WhatsApp → Linked devices → Link a device → scan the QR code.` },
    { step: 2, name: "Pair a receiving number", done: paired, who: "you (on your phone, in the console)",
      how: `Same window, step 2 "Pair your number": follow the steps with a second WhatsApp number (not the one from step 1). This proves the link works before real calls.` },
    { step: 3, name: "Turn on WhatsApp", done: waOn, who: "your AI can do this", how: `update_settings with {"whatsapp":{"enabled":true}} (or console Settings).` },
    { step: 4, name: "Turn on calling", done: callingOn, who: "your AI can do this", how: `update_settings with {"calling":{"enabled":true}} (or console Settings → Calling & limits).` },
  ];
  const next = steps.find(s => !s.done);
  const status: SetupStatus = {
    ready_to_call: ready, console: link, steps,
    next_step: ready ? "Setup is complete: call_number can place calls."
      : next ? `Step ${next.step}: ${next.name}. ${next.who === "your AI can do this" ? "Your AI can do this now." : "Needs the user's phone; tell the user the steps below."}`
      : "All steps look done but WhatsApp is not ready yet: wait a minute and check again; if it stays not ready, open Connections in the console.",
  };
  if (connections.status !== 200 || configuration.status !== 200) status.problem = `Could not read everything (connections HTTP ${connections.status}, settings HTTP ${configuration.status}); steps may be incomplete.`;
  return status;
}

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const change = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const phone = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
// Only plain nested objects are merged; arrays and values are replaced.
function merge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = merge(base[key], value);
  return out;
}

export function createUserMcpServer(ops: UserOps) {
  const server = new McpServer(
    { name: "voxdock-user", version: "0.2.0" },
    {
      instructions:
        "Tools for one VoxDock user: tune their calling agent and start real WhatsApp phone calls. Start a call only when the user asked for it. " +
        "A started call is a request, not proof anyone answered: use get_call to follow it. Never redial automatically after an unclear result. " +
        "Prompt changes are saved with history; use list_prompt_history and restore_prompt to undo. " +
        "First run setup_status: until it says ready_to_call, guide the user through its steps (linking WhatsApp needs their phone in the console).",
    },
  );
  const reply = (data: unknown, isError = false) => ({
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: (isRecord(data) ? data : { result: data }) as Record<string, unknown>,
  });
  const run = async (action: () => Promise<unknown>) => {
    try { return reply(await action()); }
    catch (error) { return reply({ error: { code: (error as { code?: string })?.code ?? "unavailable", message: String((error as Error)?.message ?? error).slice(0, 300) } }, true); }
  };
  const api = async (method: "GET" | "POST" | "PUT", path: string, body?: unknown) => {
    const result = await ops.request(method, path, body);
    if (result.status >= 400) return reply({ error: { http_status: result.status, ...(isRecord(result.body) ? result.body : { body: result.body }) } }, true);
    return reply(result.body);
  };
  const callId = z.strictObject({ call_id: z.string().min(1).max(200).describe("Call id from call_number or list_calls") });

  server.registerTool("setup_status", {
    description: "Is this user ready to make calls? Lists each setup step (done or not), who does it (the user on their phone, or you), exactly how, and the user's console link. Run this first.",
    inputSchema: z.strictObject({}), annotations: read,
  }, () => run(() => setupStatus(ops)));
  server.registerTool("whoami", { description: "Who is signed in, which agent they use, and whether calling and WhatsApp are ready.", inputSchema: z.strictObject({}), annotations: read },
    () => run(async () => {
      const me = await ops.whoami();
      const setup = await setupStatus(ops);
      return { ...(isRecord(me) ? me : {}), ready_to_call: setup.ready_to_call, setup_next_step: setup.next_step, console: setup.console };
    }));

  server.registerTool("get_settings", { description: "Read this user's call settings (calling on/off, call length, daily minutes, language, timezone and more) and the current revision.", inputSchema: z.strictObject({}), annotations: read },
    () => api("GET", "/v1/console/settings/configuration"));
  server.registerTool("update_settings", {
    description: "Change some call settings. Give only the fields to change, nested like get_settings 'settings' (for example {\"calling\":{\"max_call_seconds\":240}}). Other settings are kept.",
    inputSchema: z.strictObject({ changes: z.record(z.string(), z.unknown()).describe("Partial settings object") }), annotations: change,
  }, async ({ changes }) => {
    const current = await ops.request("GET", "/v1/console/settings/configuration");
    if (current.status >= 400 || !isRecord(current.body)) return reply({ error: { http_status: current.status, body: current.body } }, true);
    return api("PUT", "/v1/console/settings/configuration", { expected_revision: current.body.revision, settings: merge(current.body.settings, changes) });
  });

  server.registerTool("get_agent_prompt", { description: "Read the calling agent's prompt (script) and first message.", inputSchema: z.strictObject({}), annotations: read },
    () => run(() => ops.getPrompt()));
  server.registerTool("update_agent_prompt", {
    description: "Replace the calling agent's prompt and/or first message. The previous version is saved first and can be restored. Only works on the user's own agent.",
    inputSchema: z.strictObject({
      prompt: z.string().min(1).max(60000).optional().describe("The full new prompt text"),
      first_message: z.string().max(2000).optional().describe("Opening line; empty means the agent waits for the callee to speak first"),
      note: z.string().max(300).optional().describe("Short reason for the change, kept in the history"),
    }), annotations: change,
  }, (input) => run(() => ops.updatePrompt(input)));
  server.registerTool("list_prompt_history", { description: "Earlier prompt versions saved before each change, newest first, with time and note.", inputSchema: z.strictObject({}), annotations: read },
    () => run(() => ops.promptHistory()));
  server.registerTool("restore_prompt", {
    description: "Put back an earlier prompt version from list_prompt_history. The current version is saved first.",
    inputSchema: z.strictObject({ version: z.number().int().min(1).describe("Version number from list_prompt_history") }), annotations: change,
  }, ({ version }) => run(() => ops.restorePrompt(version)));

  server.registerTool("call_number", {
    description: "Start a real WhatsApp call from this user's WhatsApp to a phone number, using their agent. Only when the user asked. Reusing the same request_ref never calls twice.",
    inputSchema: z.strictObject({
      phone: z.string().min(8).max(40).describe("Phone number with country code, for example +60123456789"),
      name: z.string().max(400).optional(), company: z.string().max(400).optional(),
      request_ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/).max(200).optional().describe("Your own id for this request; same id = same call"),
    }), annotations: phone,
  }, async ({ request_ref, ...lead }) => {
    const result = await ops.request("POST", "/v1/visitor-calls", { request_ref: request_ref ?? `mcp-${crypto.randomUUID()}`, ...lead });
    if (result.status < 400) return reply(result.body);
    // The bridge answers with a short code; add the real reason in plain words when setup is not finished.
    const error: Record<string, unknown> = { http_status: result.status, ...(isRecord(result.body) ? result.body : { body: result.body }) };
    if (result.body && isRecord(result.body) && result.body.error === "busy") error.meaning = "Another call of this user is running. Try again when it ends.";
    else {
      const setup = await setupStatus(ops).catch(() => undefined);
      if (setup && !setup.ready_to_call) { error.meaning = `No call was placed: setup is not finished. ${setup.next_step}`; error.setup = setup; }
    }
    return reply({ error }, true);
  });
  server.registerTool("list_calls", {
    description: "Recent calls of this user, newest first.",
    inputSchema: z.strictObject({ limit: z.number().int().min(1).max(100).optional() }), annotations: read,
  }, ({ limit }) => api("GET", `/v1/console/calls?limit=${limit ?? 20}`));
  server.registerTool("get_call", { description: "Status and details of one call.", inputSchema: callId, annotations: read },
    ({ call_id }) => api("GET", `/v1/console/calls/${encodeURIComponent(call_id)}`));
  server.registerTool("get_call_script", { description: "The conversation text (call script) of one call.", inputSchema: callId, annotations: read },
    ({ call_id }) => api("GET", `/v1/console/calls/${encodeURIComponent(call_id)}/conversation`));
  server.registerTool("end_call", { description: "Hang up one of this user's calls.", inputSchema: callId, annotations: phone },
    ({ call_id }) => api("POST", `/v1/console/calls/${encodeURIComponent(call_id)}/end`));
  server.registerTool("whatsapp_status", { description: "This user's WhatsApp connection state. Linking a new WhatsApp needs the console QR code.", inputSchema: z.strictObject({}), annotations: read },
    () => api("GET", "/v1/console/connections"));
  server.registerTool("usage", {
    description: "Calls and talk minutes over the last 1, 7 or 30 days.",
    inputSchema: z.strictObject({ days: z.enum(["1", "7", "30"]).optional() }), annotations: read,
  }, ({ days }) => api("GET", `/v1/console/overview?days=${days ?? "7"}`));
  return server;
}

// One stateless MCP request (streamable HTTP). The bridge supplies the signed-in user's ops.
// The response is read fully before the handler closes, so nothing is cut off.
export async function handleUserMcp(request: Request, parsedBody: unknown, ops: UserOps): Promise<{ status: number; headers: [string, string][]; body: string }> {
  const handler = createMcpHandler(() => createUserMcpServer(ops));
  try {
    const response = await handler.fetch(request, parsedBody === undefined ? {} : { parsedBody });
    return { status: response.status, headers: [...response.headers], body: await response.text() };
  } finally { void handler.close().catch(() => {}); }
}

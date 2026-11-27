# Multi-tenant build plan

## Chosen on 2026-11-27 (replaces the Option B workstream table below)

One unchanged copy of the bridge per user, inside the one Railway container. No bridge code changes.

- `scripts/front-router.mjs`: owns the public port and forwards to the right user's bridge. `/u/<id>` selects a user (cookie); no selection = `main`. `/call-link/`, `/v1/visitor-calls` and `/healthz` always go to `main`.
- `scripts/railway-start.mjs`: `main` keeps `/data` and its config (only its listen address moves to loopback). Each entry of `/data/tenants.json` gets `/data/users/<id>/`, its own WhatsApp session `wa-<id>` in the shared WaCalls, and its own agent id. A user's bridge that stops is restarted alone.
- `scripts/tenant-add.mjs <id> [agent_id]`: admin only, run on the server. The ElevenLabs API key stays admin-only (one key).
- One call at a time per user. Each user's call scripts = the console Call scripts page behind their own login.

Goal, Phase 1: each user signs in, has their own WhatsApp connection, their own agent settings and their own call scripts.
Goal, Phase 2: an MCP lets a user's AI agent change their own agent settings (context prompt).

Rules for every workstream: [the safety checklist](multitenant-baseline-checklist.md) passes before and after; no kill gates; no env on/off switches; the agent script wording is not touched; audio/call runtime code is not touched; existing `/data` keeps working as user #1.

## What the code already gives us (checked 2026-11-27)

- WaCalls (the WhatsApp sidecar) already holds several WhatsApp sessions, each by id, max 1 call per session (`Dockerfile`: `-max-calls-per-session 1`).
- The bridge talks to one WaCalls session id (`apps/bridge/src/connection-whatsapp.ts`, `packages/whatsapp/src/control.ts`).
- The ElevenLabs agent id comes from config (`config.live.elevenlabs.agent_ids`, set in `scripts/railway-start.mjs`).
- One sign-in account (`apps/bridge/src/console-account.ts`), one config, one call database, one runtime (`apps/bridge/src/runtime-manager.ts`).
- An MCP already exists (`apps/mcp`).

## Two ways to reach the goal

### Option A: one copy of the app per user (almost no code)

Each user gets their own Railway service from this same repo, with their own `/data` volume.
That already gives each user: own sign-in, own WhatsApp, own agent id (`ELEVENLABS_AGENT_ID_WHATSAPP` on that service), own calls and scripts.

Code needed: only the `/scripts` access key, which is one hard-coded hash shared by every copy. Each copy needs its own key (or use the console's Call scripts page, which is already behind each user's own login).
Cost: one Railway service per user; adding a user is a manual deploy. No parallel build needed.

### Option B: one app, many users inside it (least code version)

Do not add `owner_id` columns everywhere. Instead, give each user **their own data folder** and build the same objects that exist today from it:

```
/data                 -> user #1 (today's data, unchanged)
/data/users/<id>/     -> every new user: own config, own calls.db, own WaCalls session id, own agent id
```

One login lookup picks the user's folder; every existing route then works on that user's objects. The existing code is reused, not rewritten.

## Parallel build plan for Option B

Each workstream runs in its own git worktree and branch, owned by one agent, touching only its own files. Only the maintainer merges to `main`, one branch at a time, running the checklist after each merge.

### Step 0, done first by the maintainer (blocks everything else)

| Item | Output |
| --- | --- |
| Baseline | Tag `before-multitenant`, `/data` copy, Linux test result, checklist run on production |
| Tenant contract | One small file `apps/bridge/src/tenant.ts` with the interface only: `type Tenant = { id, dataDirectory, config, store, runtime, connections }` and `getTenant(request)` returning user #1 for everything. Merged first, so it changes nothing and every workstream codes against it |

### Step 1, in parallel (each needs only the contract)

| Workstream | Does | Files it owns | Done when |
| --- | --- | --- | --- |
| W1 Accounts | Turn the one account into a user list (`users.json`); today's admin becomes user #1; admin adds users in Settings | `console-account.ts`, `console-auth.ts`, `console/src/account-settings.tsx` | Old admin login still works; a second user can log in; tests added |
| W2 Tenant loader | Build config/store/runtime/connections from a user's folder; user #1 = `/data` exactly as today | `tenant.ts`, `cli-service.ts`, `runtime-manager.ts` (wiring only) | Two tenants start side by side in a test; user #1 behaves as before |
| W3 WhatsApp per user | Each tenant uses its own WaCalls session id; Connections page links that user's own QR | `connection-whatsapp.ts`, `connection-service.ts`, `scripts/railway-start.mjs` (session id per tenant) | User #1 keeps the existing session with no re-pair; user #2 pairs a separate number |
| W4 Agent per user | Agent id per tenant in Settings; empty means the default agent, labelled "using default agent" | `packages/config` (one optional field), `console/src/settings-voice.tsx`, `packages/runtime/src/index.ts` line 87 only | User #1 still uses today's agent; user #2 can set their own id |
| W5 Scripts per user | Call scripts page and `/scripts` show the signed-in user's calls only; user #1 sees everything they see today | `scripts-page.ts`, `console/src/transcripts.tsx` | Each user sees only their own calls; nothing hidden from user #1 |
| W6 Linux test runner | One command that runs the tests in Docker on Linux, so Windows-only failures do not hide real ones | `scripts/` (new file only) | Baseline numbers recorded |

### Step 2, maintainer integration (one at a time)

Merge order: W6, W1, W2, W3, W4, W5. After each merge: tests on Linux, deploy, checklist on production. If a line breaks, revert that merge only.

### Step 3, Phase 2 (after Phase 1 passes on production)

| Workstream | Does | Files |
| --- | --- | --- |
| W7 MCP settings tools | Add `get_agent_settings` / `update_agent_settings` to the existing MCP, scoped to the credential's user; every change is recorded with who and when | `apps/mcp`, `agent-routes.ts`, `agent-credentials.ts` |

## Decisions needed from the owner before Step 0

1. Option A or Option B.
2. Calls at the same time: today one call at a time for the whole app. Per user (one each, several users at once), or still one for everyone?
3. Who creates users: only the admin, or self sign-up?
4. Per-user agent: each user supplies their own ElevenLabs agent id, or the app creates a copy of the agent for them?

# MCP for users (Phase 2 plan, not started)

Goal: each user's own AI agent can (1) keep a stored login and (2) do most of the user's work, mainly tuning their agent and starting calls.

## What exists today (checked 2026-11-27)

- `apps/mcp`: a local (stdio) MCP with 4 tools: list targets, call, get call, end call.
- It needs the source code installed on the user's computer.
- It uses a scoped token made with the CLI by the operator.
- It can only call fixed, pre-verified target numbers, not any lead's number.
- It cannot read or change settings, prompts, call scripts or WhatsApp status.
- Its base URL must have no path, so it cannot reach `/u/<id>` users.
- The bridge already has per-user token storage (`agent-credentials.ts`, hashed tokens) and a browser API to create tokens (`/admin/v1/agents`), but no console page for it.
- The agent's persona/prompt lives on ElevenLabs, not in the bridge. Changing it needs the ElevenLabs API key, which is admin-only on the server.
- Users without their own agent id share the owner's default agent. Its script must never be changed by a user.

## Proposed design

1. **MCP runs on the server**, inside each user's bridge, at `https://<domain>/u/<id>/mcp` (streamable HTTP). The user adds one URL and one token to their AI agent (Claude, Codex, others). Nothing to install.
2. **Stored login = a personal MCP token.** The user clicks "Create MCP token" on a new console page (behind their own login) and copies it once into their AI agent's config. The token is stored hashed on the server; the user can revoke or rotate it. The password never goes to the AI.
3. **Tools** (each user sees only their own data):

| Area | Tools |
| --- | --- |
| Agent tuning | `get_agent_prompt`, `update_agent_prompt` (also first message), `list_prompt_history`, `restore_prompt` |
| Call settings | `get_settings`, `update_settings` (call length, daily minutes, working hours, language) |
| Calls | `call_number` (phone, name, company), `get_call`, `end_call`, `list_calls`, `get_call_script` (conversation text) |
| Status | `whoami`, `whatsapp_status`, `usage_today` |

Not included: WhatsApp pairing (needs the phone and QR), password and account changes, other users, admin actions.

4. **Prompt safety by record-and-label, no kill gates:**
   - Every prompt change first saves the previous prompt with time and who changed it, so `restore_prompt` can always undo it.
   - A user on the shared default agent gets a clear answer instead of a change: "you are using the shared default agent; ask the admin for your own agent". The owner's script is never touched.
5. **Calls:**
   - `call_number` uses the same path as website visitor calls: the user's own WhatsApp and limits, one call at a time per user.
   - The per-number daily count and daily minutes apply.
   - A busy answer is returned as "busy, try again", never a silent drop.

## Build order (each step deployed to staging and tested before the next)

1. Bridge: user token type with access to that user's own console API (not account or token management). Console page to create, rotate and revoke it.
2. Bridge: prompt endpoints (read and update the user's own ElevenLabs agent through the server key) with prompt history.
3. Bridge: `call_number` endpoint for user tokens.
4. Remote MCP endpoint `/mcp` in the bridge with the tools above.
5. Staging tests without real calls: tools list, prompt update and restore on a test agent, settings round trip, `call_number` with calling disabled returns a labelled "calling is off" answer.
6. Production after your OK.

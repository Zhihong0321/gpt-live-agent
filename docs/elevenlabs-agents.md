# ElevenLabs Agents (Realtime Max): API notes

Notes from ElevenLabs' official docs (two research passes, 2026-11-20), and how VoxDock uses each part.
"Ours" values were read from the live agents with the API on 2026-11-20.
Read this before changing `apps/bridge/scripts/elevenlabs-agent.mjs` or
`packages/live/src/elevenlabs-transport.ts`.

Docs index: https://elevenlabs.io/docs/eleven-agents/llms.txt
(The docs moved to `/docs/eleven-agents/`; old `agents-platform` / `conversational-ai` paths may 404 or 403.)

## 1. Realtime Max (`realtime_model: 'eleven_realtime_v1_max'`)

Source: https://elevenlabs.io/docs/eleven-agents/customization/realtime-models.md

- Voice mode is **Custom** (you pick LLM, TTS, ASR) or **Realtime** (ElevenLabs manages them).
- `eleven_realtime_v1_mini` is the default and lowest latency. `eleven_realtime_v1_max` "reasons before it responds, for complex instructions and multi-step tool use".
- **Managed by ElevenLabs while Realtime is set (our values are ignored):** `agent.prompt.llm`, `reasoning_effort`, `thinking_budget`, `enable_parallel_tool_calls`, `cascade_timeout_seconds`, `tts.model_id`, `tts.expressive_mode`, `asr.provider`.
- **Still applies:** system prompt, first message, voice, languages, temperature (API only, hidden in the dashboard), tools, knowledge base, and conversation flow (turn eagerness, timeouts, interruptions).
- Max needs `max_tokens` >= 1024 or -1 (we use -1).

## 2. Client → server WebSocket events

Sources: https://elevenlabs.io/docs/eleven-agents/customization/events/client-to-server-events.md,
https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket.md

| Event | What it does | Use for |
|---|---|---|
| `contextual_update` `{type, text, context_id?}` | Background information. "Does not interrupt the current conversation flow." A newer update with the same `context_id` replaces the older one. | Call facts: name, company, purpose, next working day. |
| `user_message` `{type, text}` | "Triggers the same response flow as spoken user input." **The agent treats it as the customer speaking.** | Never use it for hidden instructions. |
| `user_activity` `{type}` | Resets the turn timeout. No content. | Keep-alive only. |

The docs give **no** supported way to send hidden mid-call instructions. The closest fit is `contextual_update`.

### Known defect in VoxDock (2026-11-20)

`elevenlabs-transport.ts` maps `session.instructions.append` and `session.commentary.append` to
`user_message` with a `[SYSTEM]` prefix. The runtime uses this for the opening ("Begin the call now"),
the duration warning, and delegation results. The agent therefore hears a fake customer turn. Effects seen on live calls:

- It speaks its own invented notes aloud, e.g. "[SYSTEM] The customer speaks English."
- 自问自答: it answers turns the customer never said.
- Messy openings when the callee's "Hello?" and the fake turn arrive together.

## 3. Starting the conversation (outbound calls)

Sources: https://elevenlabs.io/docs/eleven-agents/api-reference/agents/create.md,
https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow.md,
https://elevenlabs.io/docs/eleven-agents/customization/personalization/overrides.md

- `agent.first_message`: "If non-empty, the first message the agent will say. If empty, the agent waits for the user to start the discussion."
- `turn.initial_wait_time`: how long the agent waits for the user to start when `first_message` is empty. It falls back to `turn_timeout` (default 7 s; allowed 1–30 s).
- A per-call `conversation_config_override.agent.first_message` works only if that override is enabled in the agent's Security tab.
- **Documented way to greet after answer:** empty `first_message` plus a short `initial_wait_time` (about 2 s). The callee usually says "Hello?" and the agent replies with the opening. If they stay silent, the agent starts after the wait. No `user_message` is needed.

## 4. `language_detection` system tool

Sources: https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/language-detection.md,
https://elevenlabs.io/docs/eleven-agents/customization/voice/customization/language.md

- Fires on `detection` (the user speaks another language) or `content` (the user asks to switch). Parameters: `reason` and `language`.
- Not enabled automatically. Supported languages are set on the agent (`language_presets`; we have `en`, `ms`).
- **The description can be customised.** A blank description uses the default, which fired unreliably for us. A clear trigger description fixed English switching on 2026-11-20.
- `only_at_conversation_start` (default off) limits switching to the first two user turns.
- The system prompt "does not control … which languages an agent can speak". Switching depends on agent settings and this tool, not only on prompt text.
- Whether the agent narrates the tool call is not documented. We have heard it speak a note at the moment of switching.

## 5. Expressive / audio tags

Source: https://elevenlabs.io/docs/eleven-agents/customization/voice/expressive-mode.md

- Tags like `[slow]`, `[laughs]`, `[whispers]` affect about the next 4–5 words.
- `tts.expressive_mode` is a managed setting under Realtime, and tag behaviour under Realtime Max is not documented.
- Unknown bracketed text (e.g. `[SYSTEM] …`) is not documented. **On our calls it was spoken aloud.**

## 6. Turn, VAD and ASR settings

Sources: api-reference/agents/create.md, conversation-flow.md, overrides.md

| Setting | Docs say | Ours |
|---|---|---|
| `turn.turn_eagerness` | `patient` / `normal` / `eager`; applies to Realtime | `patient` |
| `turn.speculative_turn` | Default false. Answers during silence before turn confidence; may cost more | `false` (was true) |
| `turn.interruption_ignore_terms` | Terms that don't interrupt the agent | 嗯, 哦, ok … |
| `asr.keywords` | "Keywords to boost prediction probability for", max 50. Docs don't say whether they apply under Realtime | company names + how/what/why/sorry/pardon |
| `vad.background_voice_detection` | **Not documented** (the API accepts it). The documented feature is "Filter background speech" under Advanced > Automatic Speech Recognition in the dashboard | `true`; effect unproven |
| `turn.noisy_environment_detection` | Enterprise only; speaks a fixed "move somewhere quieter" message | off |

## 7. Prompting guide

Source: https://elevenlabs.io/docs/eleven-agents/best-practices/prompting-guide.md

- Use markdown headings such as `# Personality`, `# Goal`, `# Guardrails`, `# Tone`, `# Tools`. Models pay extra attention to `# Guardrails`.
- Keep instructions short and action-based. Mark critical steps "This step is important"; repeat the top one or two rules.
- For each tool, describe when to use it, how, and error handling.
- Prompts over about 2,000 tokens "increase latency and cost".
- The prompt controls behaviour and style, not turn-taking or language settings.

## 8. Dynamic variables (per-call values)

Sources: https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables.md,
https://elevenlabs.io/docs/eleven-agents/customization/personalization.md

- Send `dynamic_variables` inside `conversation_initiation_client_data`, e.g. `{"customer_name": "…", "company": "…"}`.
  Use them as `{{customer_name}}` in the prompt, `first_message` and tool parameters. The docs prefer this over overrides for personalising prompts and greetings.
- Custom names cannot start with `system__`. Clients cannot set or override `system__*` variables.
- System variables include `system__time` (format `%A, %H:%M %d %B %Y`, e.g. "Friday, 12:33 12 December 2025",
  **includes the weekday**, updated every turn), `system__time_date` (`%A, %d %B %Y`), `system__timezone`,
  `system__conversation_id`, `system__call_duration_secs`, `system__agent_turns`. The telephony ones
  (`system__caller_id`, `system__called_number`) are filled for Twilio or SIP. For our own WebSocket bridge this is not documented.
- `system__time` in the prompt can stop prompt caching. Setting `agent.prompt.timezone` is the recommended way to give the date and time (ours: `Asia/Kuala_Lumpur`).
- **VoxDock today:** we send **no** dynamic variables. Name, company, purpose and next working day go in as one
  `contextual_update` text ("Business context data: {…}"), and the prompt's `{公司名}` / `{姓名}` are plain text, not variables.

## 9. `conversation_initiation_client_data` (first message we send)

Source: https://elevenlabs.io/docs/eleven-agents/customization/personalization.md

- Fields (all optional): `conversation_config_override`, `dynamic_variables`, `custom_llm_extra_body`, `user_id`, `source_info`, `environment`, …
- Overrides: `agent.first_message`, `agent.language`, `agent.prompt.prompt`, `tts.voice_id` / `speed` / `stability`,
  `conversation.max_duration_seconds`, `asr.keywords`. **Each must be enabled in the agent's Security tab**, or it's an error
  (`asr.keywords` is silently ignored). On our agents every override is currently **off**.
- Send it first, before audio.
- **VoxDock today:** we send it with no fields.

## 10. Server → client events

Sources: https://elevenlabs.io/docs/eleven-agents/customization/events/client-events.md,
https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket.md

- Only events listed in the agent's `conversation.client_events` are sent. **Ours:** `audio`, `interruption`, `agent_response`,
  `user_transcript`, `agent_response_correction`, `agent_tool_response`.
- `interruption` must be selected, or barge-in never reaches us (ours: selected).
- `conversation_initiation_metadata` gives the real audio formats. We check them against the expected rate.
- `agent_response` is the full reply text, sent after its audio has started.
- `agent_response_correction` carries the **truncated** reply after an interruption (`original_agent_response`,
  `corrected_agent_response`). **VoxDock ignores it**, so our transcripts can include words the customer never heard.
- `agent_tool_response` (tool name, status) is selected but **ignored by VoxDock**. It would show when `language_detection`, `end_call` and the like fire.
- `client_tool_call` must be answered with `client_tool_result` (we answer with an error, since we expose no client tools).
- `queue_status`: hold audio arrives as normal `audio` if call queueing is on.
- Ping: reply `{"type":"pong","event_id":…}` (we do).
- Text frames that are not a JSON object close the socket with code 1008.

## 11. System tools (details)

- `end_call`: params `reason` and an optional `message` (farewell before hanging up).
- `skip_turn`: the agent stays silent until the user speaks again.
- `voicemail_detection`: LLM-based. `voicemail_message` is optional (ours empty = hang up without a message).
- `transfer_to_number`, `play_keypad_touch_tone`: phone calls via Twilio or SIP only. Not documented for a custom bridge.
- Prompting guide: say in the prompt when each tool should be used, and include error handling.

## 12. Conversation limits and timers

| Setting | Default | Ours |
|---|---|---|
| `conversation.max_duration_seconds` | 600 (60–7200) | 600. VoxDock's own limit (300 s) ends calls first |
| `turn.turn_timeout` | 7 s (1–30) | 7 |
| `turn.initial_wait_time` | falls back to `turn_timeout` | not set |
| `turn.silence_end_call_timeout` | -1 (off) | -1 |
| `turn.soft_timeout_config` | off; filler "Hhmmmm...yeah." | off |

## 13. Privacy and data retention

Sources: https://elevenlabs.io/docs/eleven-agents/customization/privacy/audio-saving.md,
https://elevenlabs.io/docs/eleven-agents/customization/privacy/retention.md,
https://elevenlabs.io/docs/eleven-agents/customization/privacy/zrm.md

- `platform_settings.privacy.record_voice`: `false` stops ElevenLabs storing new call audio.
- `platform_settings.privacy.retention_days`: -1 means no limit (the docs also mention a 2-year default; the two pages conflict).
- `zero_retention_mode`: nothing stored after the call. Available only with Realtime **Max**, in the US/EU region.
- **Ours (2026-11-20): `record_voice: true`, `retention_days: -1`, ZRM off.** ElevenLabs keeps every call recording
  and transcript with no time limit. This conflicts with the project rule "Audio is not persisted by default" (AGENTS.md).

## 14. Auth, billing and other gotchas

- `enable_auth` on the agent means a signed URL is needed (`GET /v1/convai/conversation/get-signed-url?agent_id=…` with the API key on the server). Ours: auth off, allowlist empty.
- `require_origin_header` with a non-empty allowlist rejects server clients that send no Origin header.
- Billing starts when the WebSocket is accepted (changelog, 2026-11-17).
- From 2026-11-26 the `/v1/convai` REST API enforces server-side timeouts. Handle 504 with retry and backoff (affects our agent setup script).
- Realtime **Mini** is the default and cheaper. **Max** reasons first and costs more per token. No price figures in the docs.
- No Realtime language list or Mandarin / Malay / code-switching quality notes were found.

## Not covered by the docs

- A supported way to send hidden instructions mid-call.
- Whether Realtime Max speaks or strips unknown bracketed text.
- Whether `asr.keywords` and `speculative_turn` take effect under Realtime.
- How to wait for "call answered" on non-Twilio telephony. VoxDock handles that itself.

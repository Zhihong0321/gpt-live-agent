import WebSocket from 'ws';
import type { LiveTransport } from './client.js';

export interface ElevenLabsTransportOptions {
  apiKey: string;
  agentId: string;
  /** Must equal the agent's configured PCM format (`pcm_16000` or `pcm_24000`). */
  rate: 16000 | 24000;
  usageIntervalMs?: number;
  now?: () => number;
  url?: string;
}

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' ? v : '');
const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Adapts the ElevenLabs Agents WebSocket (`/v1/convai/conversation`) to the message shapes `LiveClient`
 * already understands, so the runtime, audio pacing, transcripts and finalization are shared with the
 * GPT-Live path. The agent's persona and voice live on the ElevenLabs agent; per-call business context is
 * injected with `contextual_update`. System instructions also go as `contextual_update`: a `user_message`
 * is treated by ElevenLabs as the caller speaking, which made the agent answer turns nobody said and speak
 * invented "[SYSTEM] …" notes aloud. The agent opens the call itself (empty first message + initial wait).
 * Every inbound field is untrusted: malformed provider events are ignored (logged by code), never fatal.
 */
export function createElevenLabsTransport(options: ElevenLabsTransportOptions): LiveTransport {
  const { apiKey, agentId, rate } = options;
  if (!apiKey.trim() || /[\r\n]/.test(apiKey)) throw new Error('Invalid ElevenLabs key');
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(agentId)) throw new Error('Invalid ElevenLabs agent id');
  const now = options.now ?? (() => Date.now());
  const usageIntervalMs = options.usageIntervalMs ?? 5000;
  const base = options.url ?? 'wss://api.elevenlabs.io/v1/convai/conversation';
  let socket: WebSocket | undefined;
  let handlers: Parameters<LiveTransport['subscribe']>[0] | undefined;
  let startedAt: number | undefined;
  let finished = false;
  let usageTimer: ReturnType<typeof setInterval> | undefined;
  let lastInterruptId = 0; // Audio from before an interruption can still arrive afterwards; it must not play.
  let carry: Buffer = Buffer.alloc(0); // PCM16 needs even byte counts; keep a stray odd byte for the next chunk.

  const elapsedMs = () => (startedAt === undefined ? 0 : Math.max(0, now() - startedAt));
  const seconds = () => Math.round(elapsedMs() / 100) / 10;
  const toClient = (event: object) => { try { handlers?.message(JSON.stringify(event)); } catch { /* handler already finalized */ } };
  const toProvider = (event: object) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Transport is not open');
    socket.send(JSON.stringify(event));
  };
  const trySend = (event: object) => { try { toProvider(event); } catch { /* connection ending */ } };
  const stopUsage = () => { if (usageTimer) { clearInterval(usageTimer); usageTimer = undefined; } };
  function finish(reason: string): void {
    if (finished) return;
    finished = true; stopUsage();
    // The provider reports no final usage; wall-clock call time is the closest honest value.
    toClient({ type: 'session.closed', reason, usage: { seconds: seconds() } });
  }

  function receive(raw: string): void {
    let e: unknown;
    try { e = JSON.parse(raw); } catch { console.warn('elevenlabs_malformed_event'); return; }
    if (!object(e) || typeof e.type !== 'string') return;
    switch (e.type) {
      case 'conversation_initiation_metadata': {
        const meta = object(e.conversation_initiation_metadata_event) ? e.conversation_initiation_metadata_event : {};
        if (startedAt !== undefined) return;
        startedAt = now();
        const expected = `pcm_${rate}`;
        // A format mismatch makes audio sound wrong but must not end the call; record it for the operator.
        if (meta.agent_output_audio_format !== expected || meta.user_input_audio_format !== expected) {
          console.warn('elevenlabs_audio_format_mismatch', JSON.stringify({ expected, output: text(meta.agent_output_audio_format), input: text(meta.user_input_audio_format) }));
        }
        usageTimer = setInterval(() => toClient({ type: 'session.usage.updated', usage: { seconds: seconds() } }), usageIntervalMs);
        usageTimer.unref?.();
        toClient({ type: 'session.started', session: { id: text(meta.conversation_id) || 'elevenlabs-conversation' } });
        return;
      }
      case 'audio': {
        const audio = object(e.audio_event) ? text(e.audio_event.audio_base_64) : '';
        if (!audio) return;
        if (object(e.audio_event) && typeof e.audio_event.event_id === 'number' && e.audio_event.event_id < lastInterruptId) return;
        let pcm = Buffer.from(audio, 'base64');
        if (carry.length) { pcm = Buffer.concat([carry, pcm]); carry = Buffer.alloc(0); }
        if (pcm.length % 2) { carry = pcm.subarray(pcm.length - 1); pcm = pcm.subarray(0, pcm.length - 1); }
        if (pcm.length) toClient({ type: 'session.output_audio.delta', delta: pcm.toString('base64') });
        return;
      }
      case 'interruption': {
        const ev = object(e.interruption_event) ? e.interruption_event : {};
        lastInterruptId = Math.max(lastInterruptId, int(ev.event_id));
        carry = Buffer.alloc(0);
        toClient({ type: 'session.output_audio.interrupted' });
        return;
      }
      case 'user_transcript': {
        const ev = object(e.user_transcription_event) ? e.user_transcription_event : {};
        const delta = text(ev.user_transcript);
        if (delta) { const t = elapsedMs(); toClient({ type: 'session.input_transcript.delta', delta, start_ms: t, end_ms: t, event_id: `user-${int(ev.event_id)}` }); }
        return;
      }
      case 'agent_response': {
        const ev = object(e.agent_response_event) ? e.agent_response_event : {};
        const delta = text(ev.agent_response);
        if (delta) { const t = elapsedMs(); toClient({ type: 'session.output_transcript.delta', delta, start_ms: t, end_ms: t, event_id: `agent-${int(ev.event_id)}` }); }
        return;
      }
      case 'ping': {
        const ev = object(e.ping_event) ? e.ping_event : {};
        trySend({ type: 'pong', event_id: int(ev.event_id) });
        return;
      }
      case 'client_tool_call': {
        // The calling system exposes no client tools; answer so the agent never waits on a reply.
        const ev = object(e.client_tool_call) ? e.client_tool_call : {};
        if (ev.expects_response !== false && typeof ev.tool_call_id === 'string') trySend({ type: 'client_tool_result', tool_call_id: ev.tool_call_id, result: 'This tool is not available on this call.', is_error: true });
        return;
      }
      case 'client_error': {
        const ev = object(e.error_event) ? e.error_event : {};
        console.warn('elevenlabs_client_error', JSON.stringify({ code: int(ev.code), name: text(ev.error_name).slice(0, 80) }));
        // Before the conversation starts this is a rejection; during a call it is only recorded.
        if (startedAt === undefined) toClient({ type: 'error', error: { code: 'provider_rejected' } });
        return;
      }
      default: return; // transcripts corrections, VAD scores, usage and other events are not needed.
    }
  }

  return {
    get bufferedAmount() { return socket?.bufferedAmount ?? 0; },
    send(message) {
      let m: unknown;
      try { m = JSON.parse(message); } catch { return; }
      if (!object(m) || typeof m.type !== 'string') return;
      switch (m.type) {
        case 'session.start':
          // Persona, voice and language come from the ElevenLabs agent configuration.
          toProvider({ type: 'conversation_initiation_client_data' });
          return;
        case 'session.input_audio.append':
          if (typeof m.audio === 'string') toProvider({ user_audio_chunk: m.audio });
          return;
        case 'session.thinking.append':
        case 'session.instructions.append':
        case 'session.commentary.append':
          // Background only: never a user_message, which ElevenLabs treats as the caller speaking.
          toProvider({ type: 'contextual_update', text: text(m.content) });
          break;
        case 'session.close':
          try { socket?.close(1000); } catch { /* already closing */ }
          finish('client_closed');
          return;
        default: return;
      }
      // Appends are accepted once sent: the provider sends no acknowledgment.
      if (typeof m.event_id === 'string') toClient({ type: m.type.replace('.append', '.appended'), client_event_id: m.event_id });
    },
    terminate() { stopUsage(); try { socket?.terminate(); } catch { /* already gone */ } },
    subscribe(h) {
      if (socket) throw new Error('Transport already used');
      handlers = h;
      socket = new WebSocket(`${base}?agent_id=${encodeURIComponent(agentId)}`, {
        headers: { 'xi-api-key': apiKey },
        maxPayload: 2_000_000,
        handshakeTimeout: 15000,
        perMessageDeflate: false,
      });
      const onMessage = (data: WebSocket.RawData, binary: boolean) => { if (!binary) receive(data.toString()); };
      const onClose = () => { finish('provider_closed'); h.close(); };
      socket.on('open', h.open);
      socket.on('message', onMessage);
      socket.on('close', onClose);
      socket.on('error', h.error);
      return () => {
        socket!.off('open', h.open);
        socket!.off('message', onMessage);
        socket!.off('close', onClose);
        socket!.off('error', h.error);
        stopUsage();
        socket!.on('error', () => {});
      };
    },
  };
}

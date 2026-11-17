import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { LiveClient, createElevenLabsTransport, type LiveEvent } from './index.js';

const servers: WebSocketServer[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function setup(rate: 16000 | 24000 = 16000) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(wss);
  const headers: Array<Record<string, unknown>> = [];
  const urls: string[] = [];
  const received: Array<Record<string, unknown>> = [];
  let server!: ServerSocket;
  const connected = new Promise<void>(resolve => wss.on('connection', (socket, request) => {
    server = socket; headers.push({ ...request.headers }); urls.push(request.url ?? '');
    socket.on('message', data => received.push(JSON.parse(data.toString())));
    resolve();
  }));
  await new Promise<void>(resolve => wss.once('listening', resolve));
  const port = (wss.address() as AddressInfo).port;
  const events: LiveEvent[] = [];
  const transport = createElevenLabsTransport({ apiKey: 'test-key', agentId: 'agent_test', rate, usageIntervalMs: 20, url: `ws://127.0.0.1:${port}/v1/convai/conversation` });
  const client = new LiveClient(transport, { instructions: 'ignored by provider', rate }, event => events.push(event));
  const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 10)); expect(check()).toBe(true); };
  const send = (event: object) => server.send(JSON.stringify(event));
  const start = async () => {
    client.start(); await connected;
    await until(() => received.some(m => m.type === 'conversation_initiation_client_data'));
    send({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: { conversation_id: 'conv_1', agent_output_audio_format: `pcm_${rate}`, user_input_audio_format: `pcm_${rate}` } });
    await until(() => events.some(e => e.type === 'ready'));
  };
  return { client, events, received, send, start, until, headers, urls, server: () => server };
}

describe('ElevenLabs transport', () => {
  it('authenticates server-side, starts the agent conversation and reports ready', async () => {
    const t = await setup();
    await t.start();
    expect(t.headers[0]?.['xi-api-key']).toBe('test-key');
    expect(t.urls[0]).toContain('agent_id=agent_test');
    expect(t.events).toContainEqual({ type: 'ready', sessionId: 'conv_1' });
    t.client.close();
  });

  it('forwards caller audio and maps appends to context updates and tagged instructions', async () => {
    const t = await setup();
    await t.start();
    const pcm = Buffer.alloc(640, 1);
    t.client.appendAudio(pcm);
    t.client.thinking('Business context data: {"purpose":"intro"}');
    t.client.instructions('Begin the call now.');
    await t.until(() => t.received.length >= 4);
    expect(t.received).toContainEqual({ user_audio_chunk: pcm.toString('base64') });
    expect(t.received).toContainEqual({ type: 'contextual_update', text: 'Business context data: {"purpose":"intro"}' });
    expect(t.received).toContainEqual({ type: 'user_message', text: '[SYSTEM] Begin the call now.' });
    await t.until(() => t.events.some(e => e.type === 'thinkingAccepted') && t.events.some(e => e.type === 'instructionsAccepted'));
    t.client.close();
  });

  it('turns agent audio into even-length PCM, carrying a stray odd byte', async () => {
    const t = await setup();
    await t.start();
    t.send({ type: 'audio', audio_event: { audio_base_64: Buffer.from([1, 2, 3]).toString('base64'), event_id: 1 } });
    t.send({ type: 'audio', audio_event: { audio_base_64: Buffer.from([4, 5, 6]).toString('base64'), event_id: 2 } });
    await t.until(() => t.events.filter(e => e.type === 'audio').length === 2);
    const chunks = t.events.flatMap(e => (e.type === 'audio' ? [Array.from(e.pcm)] : []));
    expect(chunks).toEqual([[1, 2], [3, 4, 5, 6]]);
    expect(t.events.some(e => e.type === 'closed')).toBe(false);
    t.client.close();
  });

  it('reports interruptions, transcripts and answers pings without ending the call', async () => {
    const t = await setup();
    await t.start();
    t.send({ type: 'user_transcript', user_transcription_event: { user_transcript: 'hello', event_id: 3 } });
    t.send({ type: 'agent_response', agent_response_event: { agent_response: 'hi there', event_id: 4 } });
    t.send({ type: 'interruption', interruption_event: { event_id: 5 } });
    t.send({ type: 'ping', ping_event: { event_id: 9, ping_ms: 10 } });
    t.send({ type: 'client_tool_call', client_tool_call: { tool_name: 'x', tool_call_id: 'call_1', parameters: {}, event_id: 6, expects_response: true } });
    t.send({ type: 'unknown_event', anything: 1 });
    await t.until(() => t.events.some(e => e.type === 'interrupted'));
    await t.until(() => t.received.some(m => m.type === 'pong') && t.received.some(m => m.type === 'client_tool_result'));
    expect(t.received).toContainEqual({ type: 'pong', event_id: 9 });
    expect(t.received.find(m => m.type === 'client_tool_result')).toMatchObject({ tool_call_id: 'call_1', is_error: true });
    expect(t.events).toContainEqual(expect.objectContaining({ type: 'transcript', speaker: 'user', delta: 'hello', eventId: 'user-3' }));
    expect(t.events).toContainEqual(expect.objectContaining({ type: 'transcript', speaker: 'assistant', delta: 'hi there', eventId: 'agent-4' }));
    expect(t.events.some(e => e.type === 'closed')).toBe(false);
    await t.until(() => t.events.some(e => e.type === 'usage'));
    t.client.close();
  });

  it('finalizes completely when the caller side closes or the agent ends the conversation', async () => {
    const closing = await setup();
    await closing.start();
    closing.client.close();
    await closing.until(() => closing.events.some(e => e.type === 'closed'));
    expect(closing.events.at(-1)).toMatchObject({ type: 'closed', finalization: 'complete', reason: 'client_closed' });

    const remote = await setup();
    await remote.start();
    remote.server().close(1000);
    await remote.until(() => remote.events.some(e => e.type === 'closed'));
    expect(remote.events.at(-1)).toMatchObject({ type: 'closed', finalization: 'complete', reason: 'provider_closed' });
  });

  it('rejects unusable credentials before connecting', () => {
    expect(() => createElevenLabsTransport({ apiKey: ' ', agentId: 'agent_test', rate: 16000 })).toThrow();
    expect(() => createElevenLabsTransport({ apiKey: 'k', agentId: 'bad id!', rate: 16000 })).toThrow();
  });
});

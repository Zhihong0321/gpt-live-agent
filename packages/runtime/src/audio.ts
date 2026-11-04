import { performance } from 'node:perf_hooks';
import { PcmFrameQueue, PcmPacer, FfmpegResampler, hasAudiblePcm } from '@voxdock/audio';
import type { Duplex } from 'node:stream';
import type { VoiceDriver, RuntimeLive, RuntimeDependencies } from './types.js';

export type AudioFailureReason =
  | 'audio_input_overflow' | 'audio_output_overflow'
  | 'audio_input_resampler_failed' | 'audio_output_resampler_failed'
  | 'audio_live_write_failed' | 'audio_phone_write_failed' | 'audio_phone_write_pending';

/** One paced duplex route; temporary audio congestion drops stale frames. */
export class CallAudio {
  private readonly input: PcmFrameQueue;
  private readonly output: PcmFrameQueue;
  private readonly inputPacer: PcmPacer;
  private readonly outputPacer: PcmPacer;
  private readonly toLive: Duplex | undefined;
  private readonly toPhone: Duplex | undefined;
  private readonly timer: ReturnType<typeof setInterval>;
  private stopped = false;
  private writing = false;
  private inputHighWaterMs = 0;
  private outputHighWaterMs = 0;
  private inputDroppedMs = 0;
  private inputAudibleDroppedMs = 0;
  private outputDroppedMs = 0;
  constructor(private readonly voice: VoiceDriver, private readonly ref: string, rate: 16000 | 24000,
    private readonly live: RuntimeLive, private readonly fail: (reason: AudioFailureReason) => void, resampler?: RuntimeDependencies['resampler']) {
    // Keep the previously working input headroom; log drops to assess tradeoffs.
    this.input = new PcmFrameQueue(rate, 20, 2000);
    // Model audio can arrive in bursts faster than real-time playback.
    this.output = new PcmFrameQueue(voice.rate, voice.frameMs, 1500);
    this.inputPacer = new PcmPacer(this.input, pcm => {
      try { this.live.appendAudio(pcm); } catch { this.failed('audio_live_write_failed'); }
    });
    this.outputPacer = new PcmPacer(this.output, pcm => {
      // A slow write must not terminate the call or create parallel writes.
      if (this.writing) return;
      this.writing = true;
      try {
        void this.voice.writeAudio(this.ref, pcm).catch(() => this.failed('audio_phone_write_failed')).finally(() => { this.writing = false; });
      } catch { this.writing = false; this.failed('audio_phone_write_failed'); }
    });
    const factory = resampler ?? ((inputRate, outputRate) => new FfmpegResampler({ inputRate, outputRate, maxBufferedBytes: 48000 }));
    if (voice.rate !== rate) {
      this.toLive = factory(voice.rate, rate); this.toPhone = factory(rate, voice.rate);
      this.toLive.on('data', (pcm: Buffer) => this.enqueue(this.input, pcm, 'audio_input_overflow'));
      this.toPhone.on('data', (pcm: Buffer) => this.enqueueOutput(pcm));
      this.toLive.on('error', () => this.failed('audio_input_resampler_failed'));
      this.toPhone.on('error', () => this.failed('audio_output_resampler_failed'));
    }
    this.timer = setInterval(() => this.tick(), 5);
  }
  private enqueue(queue: PcmFrameQueue, pcm: Buffer, reason: AudioFailureReason): void {
    if (this.stopped) return;
    try {
      const dropped = queue.pushLatest(pcm, discarded => {
        const windowBytes = queue.bytesPerFrame;
        for (let i = 0; i < discarded.byteLength; i += windowBytes) {
          const window = discarded.subarray(i, i + windowBytes);
          if (hasAudiblePcm(window)) this.inputAudibleDroppedMs += window.byteLength / (queue.rate * 2) * 1000;
        }
      });
      this.inputDroppedMs += dropped / (queue.rate * 2) * 1000;
      this.inputHighWaterMs = Math.max(this.inputHighWaterMs, queue.bufferedBytes / (queue.rate * 2) * 1000);
    } catch { this.failed(reason); }
  }
  private enqueueOutput(pcm: Buffer): void {
    if (!this.stopped) {
      const dropped = this.output.pushLatest(pcm);
      this.outputDroppedMs += dropped / (this.output.rate * 2) * 1000;
      this.outputHighWaterMs = Math.max(this.outputHighWaterMs, this.output.bufferedBytes / (this.output.rate * 2) * 1000);
    }
  }
  receive(pcm: Buffer): void {
    if (this.stopped) return;
    if (!this.toLive) { this.enqueue(this.input, pcm, 'audio_input_overflow'); return; }
    try { if (!this.toLive.write(pcm)) this.failed('audio_input_resampler_failed'); }
    catch { this.failed('audio_input_resampler_failed'); }
  }
  play(pcm: Buffer): void {
    if (this.stopped) return;
    if (!this.toPhone) { this.enqueueOutput(pcm); return; }
    try { if (!this.toPhone.write(pcm)) this.failed('audio_output_resampler_failed'); }
    catch { this.failed('audio_output_resampler_failed'); }
  }
  hasPendingSpeech(): boolean { return this.output.hasAudibleAudio(); }
  metrics() {
    return {
      max_input_queue_ms: Math.round(this.inputHighWaterMs),
      max_output_queue_ms: Math.round(this.outputHighWaterMs),
      input_dropped_ms: Math.round(this.inputDroppedMs),
      input_audible_dropped_ms: Math.round(this.inputAudibleDroppedMs),
      output_dropped_ms: Math.round(this.outputDroppedMs),
    };
  }
  private tick(): void {
    if (this.stopped) return;
    const now = performance.now();
    this.inputPacer.tick(now);
    if (!this.stopped) this.outputPacer.tick(now);
  }
  private failed(reason: AudioFailureReason): void { if (!this.stopped) { this.close(); this.fail(reason); } }
  close(): void {
    if (this.stopped) return;
    console.info('audio_queue_summary', JSON.stringify(this.metrics()));
    this.stopped = true; clearInterval(this.timer); this.inputPacer.stop(); this.outputPacer.stop(); this.toLive?.destroy(); this.toPhone?.destroy();
  }
}

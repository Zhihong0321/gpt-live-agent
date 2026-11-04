export type PcmRate = 16000 | 24000 | 48000;

export function frameBytes(rate: PcmRate, durationMs = 20): number {
  const samples = rate * durationMs / 1000;
  if (![16000, 24000, 48000].includes(rate) || !Number.isSafeInteger(samples) || samples <= 0) {
    throw new Error('Invalid PCM frame duration or sample rate');
  }
  return samples * 2;
}

export function pcmDurationMs(pcm: Uint8Array, rate: PcmRate): number {
  frameBytes(rate);
  if (pcm.byteLength % 2) throw new Error('PCM16 requires complete samples');
  return pcm.byteLength / 2 / rate * 1000;
}

/** Conservative speech-energy check for PCM16LE. Silent frames remain below
 * the threshold, so continuous digital silence is not mistaken for playback. */
export function hasAudiblePcm(pcm: Uint8Array): boolean {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samplesPerWindow = 320;
  for (let start = 0; start + 1 < pcm.byteLength; start += samplesPerWindow * 2) {
    const end = Math.min(pcm.byteLength - pcm.byteLength % 2, start + samplesPerWindow * 2);
    let sum = 0, count = 0;
    for (let i = start; i + 1 < end; i += 2) { const v = view.getInt16(i, true); sum += v * v; count++; }
    if (count && Math.sqrt(sum / count) >= 200) return true;
  }
  return false;
}

/** A bounded mono PCM16 queue. Overflow is explicit, never silently discarded. */
export class PcmFrameQueue {
  private pending = Buffer.alloc(0);
  readonly bytesPerFrame: number;
  readonly capacity: number;
  constructor(readonly rate: PcmRate, readonly durationMs = 20, maxBufferedMs = 500) {
    this.bytesPerFrame = frameBytes(rate, durationMs);
    this.capacity = frameBytes(rate, maxBufferedMs);
    if (this.capacity < this.bytesPerFrame) throw new Error('Buffer shorter than frame');
  }
  get bufferedBytes(): number { return this.pending.length; }
  hasAudibleAudio(): boolean { return hasAudiblePcm(this.pending); }
  push(bytes: Uint8Array): void {
    if (this.pending.length + bytes.byteLength > this.capacity) throw new Error('Audio backpressure');
    this.pending = Buffer.concat([this.pending, bytes]);
  }
  /** Keep the most recent complete PCM samples when a playback queue is full. */
  pushLatest(bytes: Uint8Array, onDiscard?: (discarded: Uint8Array) => void): number {
    const all = Buffer.concat([this.pending, bytes]);
    const discard = Math.ceil(Math.max(0, all.length - this.capacity) / 2) * 2;
    if (discard > 0 && onDiscard) onDiscard(all.subarray(0, discard));
    this.pending = Buffer.from(all.subarray(discard));
    return Math.min(discard, all.length);
  }
  take(silenceOnUnderrun = false): Buffer | undefined {
    if (this.pending.length < this.bytesPerFrame) {
      if (!silenceOnUnderrun) return undefined;
      // Preserve a possible half sample for the next chunk.
      const complete = this.pending.length - this.pending.length % 2;
      const frame = Buffer.alloc(this.bytesPerFrame);
      this.pending.copy(frame, 0, 0, complete);
      this.pending = Buffer.from(this.pending.subarray(complete));
      return frame;
    }
    const frame = Buffer.from(this.pending.subarray(0, this.bytesPerFrame));
    this.pending = Buffer.from(this.pending.subarray(this.bytesPerFrame));
    return frame;
  }
  clear(): void { this.pending = Buffer.alloc(0); }
}

/** Caller ticks with a monotonic clock. At most one frame per tick; no catch-up bursts. */
export class PcmPacer {
  private due: number | undefined;
  private stopped = false;
  constructor(readonly queue: PcmFrameQueue, private readonly send: (frame: Buffer) => void) {}
  tick(nowMs: number): boolean {
    if (!Number.isFinite(nowMs)) throw new Error('Invalid clock');
    if (this.stopped || (this.due !== undefined && nowMs < this.due)) return false;
    this.send(this.queue.take(true)!);
    // Ordinary timer lateness must not change the nominal sample clock.
    // After a missed slot, restart from now instead of sending catch-up frames.
    const next = (this.due ?? nowMs) + this.queue.durationMs;
    this.due = next > nowMs ? next : nowMs + this.queue.durationMs;
    return true;
  }
  stop(): void { this.stopped = true; this.queue.clear(); }
}

export { FfmpegResampler, type ResamplerOptions, type ResamplerSpawn } from './resampler.js';

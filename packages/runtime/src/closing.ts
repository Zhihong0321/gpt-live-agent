import { hasAudiblePcm } from '@voxdock/audio';

/** Detect the agreed closing in assistant transcript fragments, then wait for
 * queued audio and two seconds of quiet before ending the call. GPT-Live does
 * not provide a definitive playback-complete event on this transport. */
export class ClosingDetector {
  private text = '';
  private matched = false;
  private lastActivity = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly pending: () => boolean, private readonly end: () => void) {}
  transcript(delta: string): void {
    if (this.matched) return;
    this.text = (this.text + delta).replace(/[\s\p{P}\p{S}]/gu, '').slice(-100);
    const normalized = this.text.replaceAll('您', '你');
    if (!normalized.includes('谢谢你的时间祝你生意兴隆') && !normalized.includes('代表恒浩能源祝你生意兴隆')) return;
    this.matched = true;
    this.lastActivity = Date.now();
    this.timer = setInterval(() => {
      if (this.pending()) { this.lastActivity = Date.now(); return; }
      if (Date.now() - this.lastActivity >= 2000) {
        this.close();
        this.end();
      }
    }, 100);
  }
  audio(pcm: Uint8Array): void { if (this.matched && hasAudiblePcm(pcm)) this.lastActivity = Date.now(); }
  close(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}

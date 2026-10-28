export function rms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const sample = pcm[i] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / pcm.length);
}

export type VoiceEvent =
  | { type: "transcript"; text: string }
  | { type: "reply"; text: string }
  | { type: "barge-in" };

export class VoiceSession {
  private speaking = false;
  private cancelTts = false;
  private inbound: number[] = [];
  private speech = false;
  private silenceFrames = 0;
  private generation = 0;

  constructor(private opts: {
    asr: { transcribe: (pcm: Int16Array, sampleRate: number) => Promise<string> };
    tts: { synthesize: (text: string) => Promise<Int16Array> };
    reply: (text: string) => Promise<string>;
    onOutbound: (pcm: Int16Array) => void;
    onEvent: (event: VoiceEvent) => void;
    bargeInRms?: number;
    silenceFrames?: number;
    sampleRate?: number;
    frameMs?: number;
  }) {}

  pushInbound(pcm: Int16Array): void {
    const energy = rms(pcm);
    const threshold = this.opts.bargeInRms ?? 500;
    if (this.speaking && energy >= threshold) {
      this.cancelTts = true;
      this.speaking = false;
      this.opts.onEvent({ type: "barge-in" });
    }
    if (this.speaking) return;
    if (energy >= threshold) {
      this.speech = true;
      this.silenceFrames = 0;
      for (const sample of pcm) this.inbound.push(sample);
      return;
    }
    if (!this.speech) return;
    this.silenceFrames += 1;
    for (const sample of pcm) this.inbound.push(sample);
    if (this.silenceFrames >= (this.opts.silenceFrames ?? 3)) {
      const audio = Int16Array.from(this.inbound);
      this.inbound = [];
      this.speech = false;
      this.silenceFrames = 0;
      void this.finish(audio);
    }
  }

  private async finish(audio: Int16Array): Promise<void> {
    const generation = ++this.generation;
    const text = (await this.opts.asr.transcribe(audio, this.opts.sampleRate ?? 8000)).trim();
    if (!text || generation !== this.generation) return;
    this.opts.onEvent({ type: "transcript", text });
    const reply = await this.opts.reply(text);
    if (generation !== this.generation) return;
    this.opts.onEvent({ type: "reply", text: reply });
    const pcm = await this.opts.tts.synthesize(reply);
    this.speaking = true;
    this.cancelTts = false;
    const frame = 160;
    const delayMs = this.opts.frameMs ?? 20;
    for (let offset = 0; offset < pcm.length; offset += frame) {
      if (this.cancelTts || generation !== this.generation) break;
      this.opts.onOutbound(pcm.subarray(offset, offset + frame));
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (generation === this.generation) this.speaking = false;
  }
}

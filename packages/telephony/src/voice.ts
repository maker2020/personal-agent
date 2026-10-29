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
  | { type: "transcript"; text: string; speechMs: number; asrMs: number }
  | { type: "reply"; text: string; llmMs: number }
  | { type: "audio"; ttsMs: number; samples: number }
  | { type: "barge-in" }
  | { type: "skip"; reason: "short" | "empty" | "cancelled" };

export const SPOKEN_HINT = "The user is on a live voice call. Reply in one or two short spoken sentences in their language. Do not use markdown, lists, or code.";

export function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[。！？!?；;\n])/u).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : [text.trim()].filter(Boolean);
}

export class VoiceSession {
  private speaking = false;
  private cancelTts = false;
  private inbound: number[] = [];
  private speech = false;
  private speechMs = 0;
  private silenceMs = 0;
  private ignored = 0;
  private noise = 50;
  private generation = 0;

  constructor(private opts: {
    asr: { transcribe: (pcm: Int16Array, sampleRate: number) => Promise<string> };
    tts: { synthesize: (text: string) => Promise<Int16Array> };
    reply: (text: string) => Promise<string>;
    onOutbound: (pcm: Int16Array) => void;
    onEvent: (event: VoiceEvent) => void;
    floorRms?: number;
    silenceMs?: number;
    minSpeechMs?: number;
    maxUtteranceMs?: number;
    prerollMs?: number;
    sampleRate?: number;
    frameMs?: number;
  }) {}

  pushInbound(pcm: Int16Array): void {
    const sampleRate = this.opts.sampleRate ?? 8000;
    const preroll = Math.round(sampleRate * (this.opts.prerollMs ?? 500) / 1000);
    let audio = pcm;
    if (this.ignored < preroll) {
      const skip = Math.min(audio.length, preroll - this.ignored);
      this.observeNoise(rms(audio.subarray(0, skip)));
      this.ignored += skip;
      if (skip >= audio.length) return;
      audio = audio.subarray(skip);
    }
    this.consume(audio, sampleRate);
  }

  stop(): void {
    this.generation += 1;
    this.cancelTts = true;
    this.speaking = false;
    this.resetUtterance();
  }

  private consume(pcm: Int16Array, sampleRate: number): void {
    const duration = pcm.length / sampleRate * 1000;
    const energy = rms(pcm);
    const threshold = Math.max(this.opts.floorRms ?? 500, this.noise * 3);
    if (this.speaking && energy >= threshold) {
      this.cancelTts = true;
      this.speaking = false;
      this.generation += 1;
      this.resetUtterance();
      this.opts.onEvent({ type: "barge-in" });
    }
    if (this.speaking) return;
    if (energy >= threshold) {
      this.speech = true;
      this.speechMs += duration;
      this.silenceMs = 0;
      this.append(pcm);
      if (this.speechMs >= (this.opts.maxUtteranceMs ?? 15_000)) this.endUtterance();
      return;
    }
    if (!this.speech) {
      this.observeNoise(energy);
      return;
    }
    this.silenceMs += duration;
    this.append(pcm);
    if (this.silenceMs >= (this.opts.silenceMs ?? 700)) this.endUtterance();
  }

  private endUtterance(): void {
    const speechMs = this.speechMs;
    const audio = Int16Array.from(this.inbound);
    this.resetUtterance();
    if (speechMs < (this.opts.minSpeechMs ?? 300)) {
      this.opts.onEvent({ type: "skip", reason: "short" });
      return;
    }
    void this.finish(audio, speechMs);
  }

  private async finish(audio: Int16Array, speechMs: number): Promise<void> {
    const generation = ++this.generation;
    const asrStarted = Date.now();
    const text = (await this.opts.asr.transcribe(audio, this.opts.sampleRate ?? 8000)).trim();
    const asrMs = Date.now() - asrStarted;
    if (generation !== this.generation) {
      this.opts.onEvent({ type: "skip", reason: "cancelled" });
      return;
    }
    if (!text) {
      this.opts.onEvent({ type: "skip", reason: "empty" });
      return;
    }
    this.opts.onEvent({ type: "transcript", text, speechMs, asrMs });
    const llmStarted = Date.now();
    const reply = (await this.opts.reply(text)).trim();
    const llmMs = Date.now() - llmStarted;
    if (!reply || generation !== this.generation) {
      this.opts.onEvent({ type: "skip", reason: "cancelled" });
      return;
    }
    this.opts.onEvent({ type: "reply", text: reply, llmMs });
    this.speaking = true;
    this.cancelTts = false;
    for (const sentence of splitSentences(reply)) {
      if (this.cancelTts || generation !== this.generation) break;
      const ttsStarted = Date.now();
      const pcm = await this.opts.tts.synthesize(sentence);
      const ttsMs = Date.now() - ttsStarted;
      if (this.cancelTts || generation !== this.generation) break;
      this.opts.onEvent({ type: "audio", ttsMs, samples: pcm.length });
      if (pcm.length === 0) continue;
      await this.play(pcm, generation);
    }
    if (generation === this.generation) this.speaking = false;
  }

  private async play(pcm: Int16Array, generation: number): Promise<void> {
    this.speaking = true;
    const sampleRate = this.opts.sampleRate ?? 8000;
    const delay = this.opts.frameMs ?? 20;
    const frame = Math.max(1, Math.round(sampleRate * delay / 1000));
    for (let offset = 0; offset < pcm.length; offset += frame) {
      if (this.cancelTts || generation !== this.generation) break;
      this.opts.onOutbound(pcm.subarray(offset, Math.min(offset + frame, pcm.length)));
      if (delay > 0 && offset + frame < pcm.length) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  private append(pcm: Int16Array): void {
    for (const sample of pcm) this.inbound.push(sample);
  }

  private resetUtterance(): void {
    this.inbound = [];
    this.speech = false;
    this.speechMs = 0;
    this.silenceMs = 0;
  }

  private observeNoise(energy: number): void {
    if (energy < this.noise) this.noise = this.noise * 0.5 + energy * 0.5;
    else this.noise = this.noise * 0.98 + energy * 0.02;
  }
}

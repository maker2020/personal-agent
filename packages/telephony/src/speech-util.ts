export interface SpeechRecognizer {
  transcribe(pcm: Int16Array, sampleRate: number): Promise<string>;
  openCall?(handlers: { onSentence: (text: string) => void; onError: (error: Error) => void }): Promise<SpeechCall>;
}

export interface SpeechSynthesizer {
  synthesize(text: string, onChunk?: (pcm: Int16Array) => void | Promise<void>): Promise<Int16Array>;
}

export type SpeechCall = {
  push(pcm: Int16Array, sampleRate: number): void;
  stop(): void;
};

export class SpeechProviderError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function redactSecret(text: string, secret: string): string {
  let detail = text;
  if (secret) detail = detail.split(secret).join("[redacted]");
  return detail.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
}

export function resampleLinear(pcm: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate || pcm.length === 0) return pcm;
  const outLength = Math.max(1, Math.round(pcm.length * toRate / fromRate));
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const position = i * fromRate / toRate;
    const left = Math.floor(position);
    const right = Math.min(left + 1, pcm.length - 1);
    const fraction = position - left;
    const a = pcm[left] ?? 0;
    const b = pcm[right] ?? a;
    out[i] = Math.round(a + (b - a) * fraction);
  }
  return out;
}

export function pcmToWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataBytes = pcm.length * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i += 1) wav.writeInt16LE(pcm[i] ?? 0, 44 + i * 2);
  return wav;
}

export function pcmFromBytes(bytes: Buffer): Int16Array {
  let data = bytes;
  if (bytes.length > 44 && bytes.toString("ascii", 0, 4) === "RIFF") {
    const marker = bytes.indexOf("data");
    if (marker >= 0 && marker + 8 <= bytes.length) data = bytes.subarray(marker + 8);
  }
  const even = data.length - (data.length % 2);
  const pcm = new Int16Array(even / 2);
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = data.readInt16LE(i * 2);
  return pcm;
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~|>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

import WebSocket from "ws";

export interface SpeechRecognizer {
  transcribe(pcm: Int16Array, sampleRate: number): Promise<string>;
}

export interface SpeechSynthesizer {
  synthesize(text: string): Promise<Int16Array>;
}

export class SpeechProviderError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type OpenAiSpeechOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice?: string;
  fetchImpl?: typeof fetch;
};

const SILICONFLOW = "https://api.siliconflow.cn/v1";
const DEFAULT_VOSK_URL = "ws://vosk:2700";
const DEFAULT_EDGE_URL = "http://vosk:2700/tts";

export function speechProviders(env: NodeJS.ProcessEnv): { asr?: SpeechRecognizer; tts?: SpeechSynthesizer; asrEnabled: boolean; ttsEnabled: boolean } {
  const asrProvider = asrChoice(env);
  const ttsProvider = ttsChoice(env);
  const asrEnabled = asrProvider === "vosk" || (asrProvider === "openai" && Boolean(env.HEARTH_ASR_API_KEY));
  const ttsEnabled = ttsProvider === "edge" || (ttsProvider === "openai" && Boolean(env.HEARTH_TTS_API_KEY));
  return {
    asrEnabled,
    ttsEnabled,
    ...(asrEnabled && asrProvider === "vosk" ? { asr: new VoskTranscription({ url: env.HEARTH_VOSK_URL || DEFAULT_VOSK_URL }) } : {}),
    ...(asrEnabled && asrProvider === "openai" ? { asr: new OpenAiTranscription({
      baseUrl: env.HEARTH_ASR_BASE_URL || SILICONFLOW,
      apiKey: env.HEARTH_ASR_API_KEY ?? "",
      model: env.HEARTH_ASR_MODEL || "FunAudioLLM/SenseVoiceSmall",
    }) } : {}),
    ...(ttsEnabled && ttsProvider === "edge" ? { tts: new EdgeSpeech({
      url: env.HEARTH_TTS_URL || DEFAULT_EDGE_URL,
      voice: env.HEARTH_TTS_VOICE || "zh-CN-XiaoxiaoNeural",
      rate: env.HEARTH_TTS_RATE || "+0%",
      pitch: env.HEARTH_TTS_PITCH || "+0Hz",
    }) } : {}),
    ...(ttsEnabled && ttsProvider === "openai" ? { tts: new OpenAiSpeech({
      baseUrl: env.HEARTH_TTS_BASE_URL || SILICONFLOW,
      apiKey: env.HEARTH_TTS_API_KEY ?? "",
      model: env.HEARTH_TTS_MODEL || "FunAudioLLM/CosyVoice2-0.5B",
      voice: env.HEARTH_TTS_VOICE || "FunAudioLLM/CosyVoice2-0.5B:anna",
    }) } : {}),
  };
}

function asrChoice(env: NodeJS.ProcessEnv): "vosk" | "openai" | "none" {
  const value = env.HEARTH_ASR_PROVIDER;
  if (value === "none") return "none";
  if (value === "openai") return "openai";
  if (value === "vosk" || value == null || value === "") return "vosk";
  return "none";
}

function ttsChoice(env: NodeJS.ProcessEnv): "edge" | "openai" | "none" {
  const value = env.HEARTH_TTS_PROVIDER;
  if (value === "none") return "none";
  if (value === "openai") return "openai";
  if (value === "edge" || value == null || value === "") return "edge";
  return "none";
}

export class VoskTranscription implements SpeechRecognizer {
  constructor(private opts: { url: string }) {}

  transcribe(pcm: Int16Array, sampleRate: number): Promise<string> {
    const audio = resampleLinear(pcm, sampleRate, 16000);
    const payload = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.opts.url);
      let settled = false;
      let text = "";
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        if (error) reject(error);
        else resolve(text.trim());
      };
      const timer = setTimeout(() => finish(new SpeechProviderError(0, "vosk timed out")), 20_000);
      socket.on("open", () => {
        socket.send(JSON.stringify({ config: { sample_rate: 16000 } }));
        if (payload.length) socket.send(payload);
        socket.send(JSON.stringify({ eof: 1 }));
      });
      socket.on("message", (data) => {
        try {
          const message = JSON.parse(String(data)) as { text?: string };
          if (typeof message.text !== "string") return;
          const next = message.text.trim();
          if (next) text = next;
          if (text) finish();
        } catch {
          finish(new SpeechProviderError(0, "vosk returned non-json"));
        }
      });
      socket.on("error", (error) => finish(new SpeechProviderError(0, `vosk ${error.message}`)));
      socket.on("close", () => finish());
    });
  }
}

export class EdgeSpeech implements SpeechSynthesizer {
  constructor(private opts: { url: string; voice: string; rate: string; pitch: string; fetchImpl?: typeof fetch }) {}

  async synthesize(text: string): Promise<Int16Array> {
    let response: Response;
    try {
      response = await (this.opts.fetchImpl ?? fetch)(this.opts.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, voice: this.opts.voice, rate: this.opts.rate, pitch: this.opts.pitch }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "network error";
      throw new SpeechProviderError(0, `edge-tts ${message}`);
    }
    if (!response.ok) throw await providerError(response, "");
    return pcmFromBytes(Buffer.from(await response.arrayBuffer()));
  }
}

export class OpenAiTranscription implements SpeechRecognizer {
  constructor(private opts: OpenAiSpeechOptions) {}

  async transcribe(pcm: Int16Array, sampleRate: number): Promise<string> {
    const wav = pcmToWav(resampleLinear(pcm, sampleRate, 16000), 16000);
    const body = new FormData();
    body.append("file", new Blob([wav], { type: "audio/wav" }), "utterance.wav");
    body.append("model", this.opts.model);
    const response = await (this.opts.fetchImpl ?? fetch)(`${trimBase(this.opts.baseUrl)}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.apiKey}` },
      body,
    });
    if (!response.ok) throw await providerError(response, this.opts.apiKey);
    const payload = await response.json() as { text?: string };
    return String(payload.text ?? "").trim();
  }
}

export class OpenAiSpeech implements SpeechSynthesizer {
  constructor(private opts: OpenAiSpeechOptions) {}

  async synthesize(text: string): Promise<Int16Array> {
    const response = await (this.opts.fetchImpl ?? fetch)(`${trimBase(this.opts.baseUrl)}/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.opts.model,
        input: text,
        voice: this.opts.voice || this.opts.model,
        response_format: "pcm",
        sample_rate: 8000,
      }),
    });
    if (!response.ok) throw await providerError(response, this.opts.apiKey);
    return pcmFromBytes(Buffer.from(await response.arrayBuffer()));
  }
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

function trimBase(url: string): string {
  return url.replace(/\/$/, "");
}

async function providerError(response: Response, secret: string): Promise<SpeechProviderError> {
  const body = await response.text().catch(() => "");
  let detail = body.slice(0, 300);
  if (secret) detail = detail.split(secret).join("[redacted]");
  detail = detail.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]");
  return new SpeechProviderError(response.status, `speech provider ${response.status}: ${detail}`);
}

import WebSocket from "ws";
import { DEFAULT_ASR_MODEL, DEFAULT_DASHSCOPE_WS, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, DashscopeAsr, DashscopeTts } from "./dashscope.js";
import { SpeechProviderError, pcmFromBytes, pcmToWav, redactSecret, resampleLinear, type SpeechCall, type SpeechRecognizer, type SpeechSynthesizer } from "./speech-util.js";

export { SpeechProviderError, pcmFromBytes, pcmToWav, redactSecret, resampleLinear, stripMarkdown, type SpeechCall, type SpeechRecognizer, type SpeechSynthesizer } from "./speech-util.js";
export { DashscopeAsr, DashscopeTts } from "./dashscope.js";

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

export type SpeechProviderName = "dashscope" | "vosk" | "openai" | "edge" | "none";

export type SpeechSetup = {
  asr?: SpeechRecognizer;
  tts?: SpeechSynthesizer;
  asrEnabled: boolean;
  ttsEnabled: boolean;
  asrProvider: SpeechProviderName;
  ttsProvider: SpeechProviderName;
  notes: string[];
};

export function speechProviders(env: NodeJS.ProcessEnv, warn?: (message: string) => void): SpeechSetup {
  const notes: string[] = [];
  const asrChoice = providerChoice(env.HEARTH_ASR_PROVIDER, ["none", "openai", "vosk", "dashscope"], "dashscope");
  const ttsChoice = providerChoice(env.HEARTH_TTS_PROVIDER, ["none", "openai", "edge", "dashscope"], "dashscope");
  const key = env.HEARTH_DASHSCOPE_API_KEY ?? "";
  const vosk = new VoskTranscription({ url: env.HEARTH_VOSK_URL || DEFAULT_VOSK_URL });
  const edge = new EdgeSpeech({
    url: env.HEARTH_TTS_URL || DEFAULT_EDGE_URL,
    voice: env.HEARTH_TTS_VOICE || "zh-CN-XiaoxiaoNeural",
    rate: env.HEARTH_TTS_RATE || "+0%",
    pitch: env.HEARTH_TTS_PITCH || "+0Hz",
  });
  const dashAsr = key ? new DashscopeAsr({
    url: env.HEARTH_DASHSCOPE_WS_URL || DEFAULT_DASHSCOPE_WS,
    apiKey: key,
    model: env.HEARTH_DASHSCOPE_ASR_MODEL || DEFAULT_ASR_MODEL,
  }) : undefined;
  const dashTts = key ? new DashscopeTts({
    url: env.HEARTH_DASHSCOPE_WS_URL || DEFAULT_DASHSCOPE_WS,
    apiKey: key,
    model: env.HEARTH_DASHSCOPE_TTS_MODEL || DEFAULT_TTS_MODEL,
    voice: env.HEARTH_DASHSCOPE_TTS_VOICE || DEFAULT_TTS_VOICE,
  }) : undefined;
  const report = (message: string) => {
    const safe = redactSecret(message, key);
    notes.push(safe);
    warn?.(safe);
  };
  let asr: SpeechRecognizer | undefined;
  let asrProvider: SpeechProviderName = "none";
  if (asrChoice === "none") asrProvider = "none";
  else if (asrChoice === "openai") {
    if (env.HEARTH_ASR_API_KEY) {
      asr = new OpenAiTranscription({
        baseUrl: env.HEARTH_ASR_BASE_URL || SILICONFLOW,
        apiKey: env.HEARTH_ASR_API_KEY,
        model: env.HEARTH_ASR_MODEL || "FunAudioLLM/SenseVoiceSmall",
      });
      asrProvider = "openai";
    }
  } else if (asrChoice === "vosk") {
    asr = vosk;
    asrProvider = "vosk";
  } else if (dashAsr) {
    asr = new FallbackRecognizer(dashAsr, vosk, report);
    asrProvider = "dashscope";
  } else {
    asr = vosk;
    asrProvider = "vosk";
    report("DashScope speech recognition needs HEARTH_DASHSCOPE_API_KEY; using Vosk");
  }
  let tts: SpeechSynthesizer | undefined;
  let ttsProvider: SpeechProviderName = "none";
  if (ttsChoice === "none") ttsProvider = "none";
  else if (ttsChoice === "openai") {
    if (env.HEARTH_TTS_API_KEY) {
      tts = new OpenAiSpeech({
        baseUrl: env.HEARTH_TTS_BASE_URL || SILICONFLOW,
        apiKey: env.HEARTH_TTS_API_KEY,
        model: env.HEARTH_TTS_MODEL || "FunAudioLLM/CosyVoice2-0.5B",
        voice: env.HEARTH_TTS_VOICE || "FunAudioLLM/CosyVoice2-0.5B:anna",
      });
      ttsProvider = "openai";
    }
  } else if (ttsChoice === "edge") {
    tts = edge;
    ttsProvider = "edge";
  } else if (dashTts) {
    tts = new FallbackSynthesizer(dashTts, edge, report);
    ttsProvider = "dashscope";
  } else {
    tts = edge;
    ttsProvider = "edge";
    report("DashScope speech synthesis needs HEARTH_DASHSCOPE_API_KEY; using Edge");
  }
  return { asr, tts, asrEnabled: Boolean(asr), ttsEnabled: Boolean(tts), asrProvider, ttsProvider, notes };
}

function providerChoice(value: string | undefined, allowed: SpeechProviderName[], fallback: SpeechProviderName): SpeechProviderName {
  if (value == null || value === "") return fallback;
  return allowed.includes(value as SpeechProviderName) ? value as SpeechProviderName : "none";
}

class FallbackRecognizer implements SpeechRecognizer {
  private primaryDown = false;
  constructor(private primary: SpeechRecognizer, private fallback: SpeechRecognizer, private warn: (message: string) => void) {}

  async transcribe(pcm: Int16Array, sampleRate: number): Promise<string> {
    if (!this.primaryDown) {
      try { return await this.primary.transcribe(pcm, sampleRate); }
      catch (error) {
        this.primaryDown = true;
        this.warn(errorText(error));
      }
    }
    return this.fallback.transcribe(pcm, sampleRate);
  }

  openCall(handlers: { onSentence: (text: string) => void; onError: (error: Error) => void }): Promise<SpeechCall> {
    if (!this.primary.openCall || this.primaryDown) return Promise.reject(new SpeechProviderError(0, "dashscope asr unavailable"));
    return this.primary.openCall({
      onSentence: handlers.onSentence,
      onError: (error) => {
        this.primaryDown = true;
        this.warn(errorText(error));
        handlers.onError(error);
      },
    }).catch((error: unknown) => {
      this.primaryDown = true;
      const wrapped = error instanceof Error ? error : new SpeechProviderError(0, "dashscope asr failed");
      this.warn(errorText(wrapped));
      handlers.onError(wrapped);
      throw wrapped;
    });
  }
}

class FallbackSynthesizer implements SpeechSynthesizer {
  private primaryDown = false;
  constructor(private primary: SpeechSynthesizer, private fallback: SpeechSynthesizer, private warn: (message: string) => void) {}

  async synthesize(text: string, onChunk?: (pcm: Int16Array) => void | Promise<void>): Promise<Int16Array> {
    if (!this.primaryDown) {
      try { return await this.primary.synthesize(text, onChunk); }
      catch (error) {
        this.primaryDown = true;
        this.warn(errorText(error));
      }
    }
    return this.fallback.synthesize(text, onChunk);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "speech provider failed";
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

function trimBase(url: string): string {
  return url.replace(/\/$/, "");
}

async function providerError(response: Response, secret: string): Promise<SpeechProviderError> {
  const body = await response.text().catch(() => "");
  return new SpeechProviderError(response.status, `speech provider ${response.status}: ${redactSecret(body.slice(0, 300), secret)}`);
}

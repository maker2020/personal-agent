import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { SpeechProviderError, pcmFromBytes, redactSecret, resampleLinear, type SpeechCall, type SpeechRecognizer, type SpeechSynthesizer } from "./speech-util.js";

/** Still-supported DashScope host. A workspace host can be set with HEARTH_DASHSCOPE_WS_URL. */
export const DEFAULT_DASHSCOPE_WS = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
export const DEFAULT_ASR_MODEL = "paraformer-realtime-8k-v2";
export const DEFAULT_TTS_MODEL = "cosyvoice-v2";
export const DEFAULT_TTS_VOICE = "longxiaochun_v2";

type ServerEvent = {
  header?: { event?: string; error_code?: string; error_message?: string };
  payload?: { output?: { sentence?: { text?: string; sentence_end?: boolean; heartbeat?: boolean } } };
};

export class DashscopeAsr implements SpeechRecognizer {
  constructor(private opts: { url: string; apiKey: string; model: string }) {}

  transcribe(pcm: Int16Array, sampleRate: number): Promise<string> {
    const audio = pcm8k(pcm, sampleRate);
    return this.session((send) => {
      if (audio.length) send(audio);
    });
  }

  openCall(handlers: { onSentence: (text: string) => void; onError: (error: Error) => void }): Promise<SpeechCall> {
    return new Promise((resolve, reject) => {
      const taskId = randomUUID();
      let opened = false;
      let failed = false;
      const socket = connect(this.opts.url, this.opts.apiKey);
      const fail = (error: SpeechProviderError) => {
        if (failed) return;
        failed = true;
        clearTimeout(timer);
        socket.close();
        if (opened) handlers.onError(error);
        else reject(error);
      };
      const timer = setTimeout(() => fail(this.error("dashscope asr timed out")), 20_000);
      socket.on("open", () => socket.send(JSON.stringify(asrRunTask(taskId, this.opts.model))));
      socket.on("message", (data, isBinary) => {
        if (isBinary || failed) return;
        const event = parseEvent(data, (message) => fail(this.error(message)));
        if (!event) return;
        const name = event.header?.event;
        if (name === "task-started" && !opened) {
          opened = true;
          clearTimeout(timer);
          resolve({
            push: (next, rate) => {
              const bytes = pcm8k(next, rate);
              if (bytes.length) socket.send(bytes);
            },
            stop: () => {
              socket.send(JSON.stringify(finishTask(taskId)));
              socket.close();
            },
          });
          return;
        }
        const text = sentenceText(event);
        if (text) handlers.onSentence(text);
        if (name === "task-failed") fail(this.error(failureText(event)));
      });
      socket.on("error", (error) => fail(this.error(`dashscope asr ${error.message}`)));
      socket.on("close", () => { if (!opened) fail(this.error("dashscope asr closed")); });
    });
  }

  private session(writeAudio: (send: (audio: Buffer) => void) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const taskId = randomUUID();
      let started = false;
      let text = "";
      const socket = connect(this.opts.url, this.opts.apiKey);
      let settled = false;
      const finish = (error?: SpeechProviderError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        if (error) reject(error);
        else resolve(text.trim());
      };
      const timer = setTimeout(() => finish(this.error("dashscope asr timed out")), 20_000);
      socket.on("open", () => socket.send(JSON.stringify(asrRunTask(taskId, this.opts.model))));
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const event = parseEvent(data, (message) => finish(this.error(message)));
        if (!event) return;
        const name = event.header?.event;
        if (name === "task-started" && !started) {
          started = true;
          writeAudio((audio) => socket.send(audio));
          socket.send(JSON.stringify(finishTask(taskId)));
          return;
        }
        const next = sentenceText(event);
        if (next) text = text ? `${text}${next}` : next;
        if (name === "task-finished") finish();
        if (name === "task-failed") finish(this.error(failureText(event)));
      });
      socket.on("error", (error) => finish(this.error(`dashscope asr ${error.message}`)));
      socket.on("close", () => { if (started) finish(); });
    });
  }

  private error(message: string): SpeechProviderError {
    return new SpeechProviderError(0, redactSecret(message, this.opts.apiKey));
  }
}

export class DashscopeTts implements SpeechSynthesizer {
  constructor(private opts: { url: string; apiKey: string; model: string; voice: string }) {}

  synthesize(text: string, onChunk?: (pcm: Int16Array) => void | Promise<void>): Promise<Int16Array> {
    const taskId = randomUUID();
    return new Promise((resolve, reject) => {
      const parts: Buffer[] = [];
      let started = false;
      const socket = connect(this.opts.url, this.opts.apiKey);
      let settled = false;
      const finish = (error?: SpeechProviderError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        if (error) reject(error);
        else resolve(pcmFromBytes(Buffer.concat(parts)));
      };
      const timer = setTimeout(() => finish(this.error("dashscope tts timed out")), 20_000);
      socket.on("open", () => socket.send(JSON.stringify(ttsRunTask(taskId, this.opts.model, this.opts.voice))));
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          const bytes = asBuffer(data);
          if (!bytes.length) return;
          parts.push(bytes);
          if (onChunk) void Promise.resolve(onChunk(pcmFromBytes(bytes))).catch((error: unknown) => {
            finish(this.error(error instanceof Error ? error.message : "playback failed"));
          });
          return;
        }
        const event = parseEvent(data, (message) => finish(this.error(message)));
        if (!event) return;
        const name = event.header?.event;
        if (name === "task-started" && !started) {
          started = true;
          socket.send(JSON.stringify(continueTask(taskId, text)));
          socket.send(JSON.stringify(finishTask(taskId)));
          return;
        }
        if (name === "task-finished") finish();
        if (name === "task-failed") finish(this.error(failureText(event)));
      });
      socket.on("error", (error) => finish(this.error(`dashscope tts ${error.message}`)));
      socket.on("close", () => { if (started) finish(); });
    });
  }

  private error(message: string): SpeechProviderError {
    return new SpeechProviderError(0, redactSecret(message, this.opts.apiKey));
  }
}

function connect(url: string, apiKey: string): WebSocket {
  return new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}`, "user-agent": "hearth" } });
}

function asrRunTask(taskId: string, model: string): unknown {
  return {
    header: { action: "run-task", task_id: taskId, streaming: "duplex" },
    payload: {
      task_group: "audio",
      task: "asr",
      function: "recognition",
      model,
      parameters: {
        format: "pcm",
        sample_rate: 8000,
        language_hints: ["zh"],
        semantic_punctuation_enabled: false,
        max_sentence_silence: 700,
        heartbeat: true,
      },
      input: {},
    },
  };
}

function ttsRunTask(taskId: string, model: string, voice: string): unknown {
  return {
    header: { action: "run-task", task_id: taskId, streaming: "duplex" },
    payload: {
      task_group: "audio",
      task: "tts",
      function: "SpeechSynthesizer",
      model,
      parameters: { text_type: "PlainText", voice, format: "pcm", sample_rate: 8000 },
      input: {},
    },
  };
}

function continueTask(taskId: string, text: string): unknown {
  return {
    header: { action: "continue-task", task_id: taskId, streaming: "duplex" },
    payload: { input: { text } },
  };
}

function finishTask(taskId: string): unknown {
  return {
    header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
    payload: { input: {} },
  };
}

function pcm8k(pcm: Int16Array, sampleRate: number): Buffer {
  const audio = sampleRate === 8000 ? pcm : resampleLinear(pcm, sampleRate, 8000);
  return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
}

function parseEvent(data: WebSocket.RawData, onBad: (message: string) => void): ServerEvent | undefined {
  try {
    return JSON.parse(asBuffer(data).toString("utf8")) as ServerEvent;
  } catch {
    onBad("dashscope returned non-json");
    return undefined;
  }
}

function sentenceText(event: ServerEvent): string {
  const sentence = event.payload?.output?.sentence;
  if (!sentence || sentence.heartbeat || sentence.sentence_end !== true) return "";
  return (sentence.text ?? "").trim();
}

function failureText(event: ServerEvent): string {
  const code = event.header?.error_code ?? "task-failed";
  const message = event.header?.error_message ?? "task-failed";
  return `dashscope ${code}: ${message}`;
}

function asBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

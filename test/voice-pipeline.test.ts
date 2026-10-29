import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { WebSocketServer } from "ws";
import { VoiceSession } from "../packages/telephony/src/voice.js";
import { EdgeSpeech, OpenAiSpeech, OpenAiTranscription, VoskTranscription, pcmToWav, resampleLinear, speechProviders, stripMarkdown } from "../packages/telephony/src/providers.js";

function pcm(ms: number, value: number, rate = 8000): Int16Array {
  return Int16Array.from({ length: Math.round(rate * ms / 1000) }, () => value);
}

test("one second of speech becomes one transcription and an empty transcript does not reply", async () => {
  let transcripts = 0;
  let replies = 0;
  const heard = new VoiceSession({
    asr: { transcribe: async () => { transcripts += 1; return "你好"; } },
    tts: { synthesize: async () => new Int16Array(160) },
    reply: async () => { replies += 1; return "在"; },
    onOutbound: () => undefined,
    onEvent: () => undefined,
    frameMs: 0,
  });
  heard.pushInbound(pcm(1000, 8000));
  heard.pushInbound(pcm(700, 0));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(transcripts, 1);
  assert.equal(replies, 1);

  let emptyReplies = 0;
  const silent = new VoiceSession({
    asr: { transcribe: async () => "" },
    tts: { synthesize: async () => { throw new Error("tts"); } },
    reply: async () => { emptyReplies += 1; return "no"; },
    onOutbound: () => undefined,
    onEvent: () => undefined,
    frameMs: 0,
  });
  silent.pushInbound(pcm(1000, 8000));
  silent.pushInbound(pcm(700, 0));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(emptyReplies, 0);
});

test("outbound frames are about 20 ms apart", async () => {
  const times: number[] = [];
  const session = new VoiceSession({
    asr: { transcribe: async () => "你好" },
    tts: { synthesize: async () => new Int16Array(160 * 5) },
    reply: async () => "在",
    onOutbound: () => times.push(Date.now()),
    onEvent: () => undefined,
    frameMs: 20,
  });
  session.pushInbound(pcm(1000, 8000));
  session.pushInbound(pcm(700, 0));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(times.length, 5);
  for (let i = 1; i < times.length; i += 1) {
    const gap = (times[i] ?? 0) - (times[i - 1] ?? 0);
    assert.ok(gap >= 12 && gap <= 45, `gap ${gap}`);
  }
});

test("openai speech adapter posts wav audio and reads 8 kHz pcm", async () => {
  const asr = new OpenAiTranscription({
    baseUrl: "https://api.siliconflow.cn/v1",
    apiKey: "sk-test-secret",
    model: "FunAudioLLM/SenseVoiceSmall",
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://api.siliconflow.cn/v1/audio/transcriptions");
      assert.ok(init?.body instanceof FormData);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer sk-test-secret");
      return new Response(JSON.stringify({ text: " 你好 " }), { status: 200 });
    },
  });
  assert.equal(await asr.transcribe(pcm(20, 1000), 8000), "你好");
  const up = resampleLinear(pcm(20, 1000), 8000, 16000);
  assert.equal(up.length, 320);
  assert.equal(pcmToWav(up, 16000).toString("ascii", 0, 4), "RIFF");

  const tts = new OpenAiSpeech({
    baseUrl: "https://api.siliconflow.cn/v1/",
    apiKey: "sk-test-secret",
    model: "FunAudioLLM/CosyVoice2-0.5B",
    voice: "FunAudioLLM/CosyVoice2-0.5B:anna",
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://api.siliconflow.cn/v1/audio/speech");
      const body = JSON.parse(String(init?.body)) as { response_format: string; sample_rate: number; voice: string };
      assert.equal(body.response_format, "pcm");
      assert.equal(body.sample_rate, 8000);
      assert.equal(body.voice, "FunAudioLLM/CosyVoice2-0.5B:anna");
      const bytes = Buffer.alloc(4);
      bytes.writeInt16LE(7, 0);
      bytes.writeInt16LE(-7, 2);
      return new Response(bytes, { status: 200 });
    },
  });
  const spoken = await tts.synthesize("在");
  assert.deepEqual([...spoken], [7, -7]);

  const denied = new OpenAiTranscription({
    baseUrl: "https://api.siliconflow.cn/v1",
    apiKey: "sk-test-secret",
    model: "m",
    fetchImpl: async () => new Response("bad sk-test-secret", { status: 401 }),
  });
  await assert.rejects(() => denied.transcribe(pcm(20, 1), 8000), (error: Error) => {
    assert.equal((error as { status?: number }).status, 401);
    assert.equal(error.message.includes("sk-test-secret"), false);
    return true;
  });
});

test("a missing DashScope key uses Vosk and Edge, and openai stays optional", async () => {
  const defaults = speechProviders({});
  assert.equal(defaults.asrProvider, "vosk");
  assert.equal(defaults.ttsProvider, "edge");
  assert.equal(defaults.asrEnabled, true);
  assert.equal(defaults.ttsEnabled, true);
  assert.match(defaults.notes.join("\n"), /HEARTH_DASHSCOPE_API_KEY/);
  assert.equal(speechProviders({ HEARTH_ASR_PROVIDER: "none" }).asrEnabled, false);
  assert.equal(speechProviders({ HEARTH_TTS_PROVIDER: "none" }).ttsEnabled, false);
  assert.equal(speechProviders({ HEARTH_ASR_PROVIDER: "openai" }).asrEnabled, false);
  assert.equal(speechProviders({ HEARTH_ASR_PROVIDER: "openai", HEARTH_ASR_API_KEY: "k" }).asrEnabled, true);
  const keyed = speechProviders({ HEARTH_DASHSCOPE_API_KEY: "sk-present-not-logged" });
  assert.equal(keyed.asrProvider, "dashscope");
  assert.equal(keyed.ttsProvider, "dashscope");
  assert.equal(keyed.notes.join("\n").includes("sk-present-not-logged"), false);
  assert.equal(stripMarkdown("**你好** [链接](https://example.com)"), "你好 链接");
  const compose = await readFile("docker-compose.yml", "utf8");
  assert.match(compose, /mem_limit: 512m/);
  assert.match(compose, /profiles: \["vosk"\]/);
  assert.match(compose, /paraformer-realtime-8k-v2/);
  assert.match(compose, /HEARTH_VOSK_URL: \$\{HEARTH_VOSK_URL:-ws:\/\/vosk:2700\}/);
  assert.equal(compose.includes("2700:2700"), false);
  const gateway = compose.slice(compose.indexOf("\n  gateway:"));
  assert.equal(gateway.includes("\n      vosk:"), false);
});

test("vosk websocket and edge http adapters", async () => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => server.on("listening", resolve));
  const port = (server.address() as { port: number }).port;
  server.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        const message = JSON.parse(String(data)) as { eof?: number };
        if (message.eof) socket.send(JSON.stringify({ text: "你好" }));
      }
    });
  });
  try {
    const asr = new VoskTranscription({ url: `ws://127.0.0.1:${port}` });
    assert.equal(await asr.transcribe(pcm(40, 1000), 8000), "你好");
  } finally {
    for (const client of server.clients) client.close();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
  const tts = new EdgeSpeech({
    url: "http://vosk:2700/tts",
    voice: "zh-CN-XiaoxiaoNeural",
    rate: "+10%",
    pitch: "+0Hz",
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "http://vosk:2700/tts");
      const body = JSON.parse(String(init?.body)) as { voice: string; rate: string };
      assert.equal(body.voice, "zh-CN-XiaoxiaoNeural");
      assert.equal(body.rate, "+10%");
      const bytes = Buffer.alloc(4);
      bytes.writeInt16LE(3, 0);
      bytes.writeInt16LE(4, 2);
      return new Response(bytes, { status: 200 });
    },
  });
  assert.deepEqual([...(await tts.synthesize("在"))], [3, 4]);
  const down = new EdgeSpeech({
    url: "http://vosk:2700/tts",
    voice: "zh-CN-XiaoxiaoNeural",
    rate: "+0%",
    pitch: "+0Hz",
    fetchImpl: async () => { throw new Error("network down"); },
  });
  await assert.rejects(() => down.synthesize("在"), /edge-tts network down/);
});

test("the first sentence is spoken before the next sentence is synthesized", async () => {
  let playedFirst = false;
  let sawSecond = false;
  const session = new VoiceSession({
    asr: { transcribe: async () => "你好" },
    tts: {
      synthesize: async (text) => {
        if (text.startsWith("二")) {
          sawSecond = true;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        return new Int16Array(160);
      },
    },
    reply: async () => "一。二。",
    onOutbound: () => { if (!sawSecond) playedFirst = true; },
    onEvent: () => undefined,
    frameMs: 0,
    prerollMs: 0,
    minSpeechMs: 20,
    silenceMs: 20,
  });
  session.pushInbound(pcm(40, 8000));
  session.pushInbound(pcm(40, 0));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(playedFirst, true);
  assert.equal(sawSecond, true);
});

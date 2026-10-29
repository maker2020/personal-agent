import assert from "node:assert/strict";
import test from "node:test";
import { VoiceSession } from "../packages/telephony/src/voice.js";
import { OpenAiSpeech, OpenAiTranscription, pcmToWav, resampleLinear, speechProviders, stripMarkdown } from "../packages/telephony/src/providers.js";

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

test("speech stays off until a provider and key are set", () => {
  assert.equal(speechProviders({}).asrEnabled, false);
  assert.equal(speechProviders({ HEARTH_ASR_PROVIDER: "none", HEARTH_ASR_API_KEY: "k" }).asrEnabled, false);
  const on = speechProviders({ HEARTH_ASR_API_KEY: "k", HEARTH_TTS_PROVIDER: "openai", HEARTH_TTS_API_KEY: "k" });
  assert.equal(on.asrEnabled, true);
  assert.equal(on.ttsEnabled, true);
  assert.equal(stripMarkdown("**你好** [链接](https://example.com)"), "你好 链接");
});

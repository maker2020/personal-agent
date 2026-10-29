import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocketServer } from "ws";
import { MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket, usePCMU } from "werift";
import { startHearth } from "../packages/gateway/src/app.js";
import { pcmToPayload } from "../packages/telephony/src/g711.js";
import { speechProviders } from "../packages/telephony/src/providers.js";
import { VoiceSession } from "../packages/telephony/src/voice.js";

const KEY = "sk-dashscope-acceptance-key-do-not-log";

function pcm(ms: number, value: number, rate = 8000): Int16Array {
  return Int16Array.from({ length: Math.round(rate * ms / 1000) }, () => value);
}

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  const record = (...args: unknown[]) => lines.push(args.map((item) => String(item)).join(" "));
  console.log = (...args: unknown[]) => { record(...args); log(...args); };
  console.error = (...args: unknown[]) => { record(...args); err(...args); };
  return { lines, restore: () => { console.log = log; console.error = err; } };
}

function httpPort(server: { listen: (port: number, host: string, done: () => void) => void; address: () => AddressInfo | string | null }): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function wsPort(server: WebSocketServer): Promise<number> {
  if (server.address()) return (server.address() as AddressInfo).port;
  await new Promise((resolve) => server.on("listening", resolve));
  return (server.address() as AddressInfo).port;
}

test("dashscope recognition sends 8 kHz pcm and reads sentence_end", async () => {
  const seen: Array<{ action?: string; model?: string; sampleRate?: number; bytes?: number }> = [];
  const server = new WebSocketServer({ port: 0 });
  const port = await wsPort(server);
  server.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        seen.push({ bytes: Buffer.from(data as Buffer).length });
        return;
      }
      const message = JSON.parse(String(data)) as { header?: { action?: string; task_id?: string }; payload?: { model?: string; parameters?: { sample_rate?: number }; input?: { text?: string } } };
      const action = message.header?.action;
      seen.push({ action, model: message.payload?.model, sampleRate: message.payload?.parameters?.sample_rate });
      if (action === "run-task") socket.send(JSON.stringify({ header: { event: "task-started", task_id: message.header?.task_id }, payload: {} }));
      if (action === "finish-task") {
        socket.send(JSON.stringify({ header: { event: "result-generated", task_id: message.header?.task_id }, payload: { output: { sentence: { text: "你好", sentence_end: true, heartbeat: false } } } }));
        socket.send(JSON.stringify({ header: { event: "task-finished", task_id: message.header?.task_id }, payload: {} }));
      }
    });
  });
  try {
    const speech = speechProviders({
      HEARTH_ASR_PROVIDER: "dashscope",
      HEARTH_TTS_PROVIDER: "none",
      HEARTH_DASHSCOPE_API_KEY: KEY,
      HEARTH_DASHSCOPE_WS_URL: `ws://127.0.0.1:${port}`,
    });
    assert.equal(await speech.asr?.transcribe(pcm(20, 1000), 8000), "你好");
    const run = seen.find((item) => item.action === "run-task");
    assert.equal(run?.model, "paraformer-realtime-8k-v2");
    assert.equal(run?.sampleRate, 8000);
    assert.equal(seen.some((item) => item.action === "continue-task"), false);
    assert.equal(seen.find((item) => item.bytes)?.bytes, 320);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test("dashscope synthesis requests 8000 Hz pcm", async () => {
  const seen: Array<{ action?: string; model?: string; voice?: string; sampleRate?: number; format?: string; text?: string }> = [];
  const server = new WebSocketServer({ port: 0 });
  const port = await wsPort(server);
  server.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(String(data)) as { header?: { action?: string; task_id?: string }; payload?: { model?: string; parameters?: { sample_rate?: number; format?: string; voice?: string }; input?: { text?: string } } };
      const action = message.header?.action;
      seen.push({
        action,
        model: message.payload?.model,
        voice: message.payload?.parameters?.voice,
        sampleRate: message.payload?.parameters?.sample_rate,
        format: message.payload?.parameters?.format,
        text: message.payload?.input?.text,
      });
      if (action === "run-task") socket.send(JSON.stringify({ header: { event: "task-started", task_id: message.header?.task_id }, payload: {} }));
      if (action === "continue-task") {
        const audio = Buffer.alloc(4);
        audio.writeInt16LE(3, 0);
        audio.writeInt16LE(4, 2);
        socket.send(audio);
      }
      if (action === "finish-task") socket.send(JSON.stringify({ header: { event: "task-finished", task_id: message.header?.task_id }, payload: {} }));
    });
  });
  try {
    const speech = speechProviders({
      HEARTH_ASR_PROVIDER: "none",
      HEARTH_TTS_PROVIDER: "dashscope",
      HEARTH_DASHSCOPE_API_KEY: KEY,
      HEARTH_DASHSCOPE_WS_URL: `ws://127.0.0.1:${port}`,
    });
    assert.deepEqual([...(await speech.tts?.synthesize("在") ?? [])], [3, 4]);
    const run = seen.find((item) => item.action === "run-task");
    assert.equal(run?.model, "cosyvoice-v2");
    assert.equal(run?.voice, "longxiaochun_v2");
    assert.equal(run?.format, "pcm");
    assert.equal(run?.sampleRate, 8000);
    assert.equal(seen.find((item) => item.action === "continue-task")?.text, "在");
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test("a rejected DashScope key falls back, and the key is absent from logs and the store", async () => {
  const logs = capture();
  const warnings: string[] = [];
  const dash = new WebSocketServer({ port: 0 });
  const vosk = new WebSocketServer({ port: 0 });
  const dashPort = await wsPort(dash);
  const voskPort = await wsPort(vosk);
  dash.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, `Bearer ${KEY}`);
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(String(data)) as { header?: { task_id?: string } };
      socket.send(JSON.stringify({
        header: { event: "task-failed", task_id: message.header?.task_id, error_code: "InvalidApiKey", error_message: `rejected ${KEY}` },
        payload: {},
      }));
    });
  });
  vosk.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(String(data)) as { eof?: number };
      if (message.eof) socket.send(JSON.stringify({ text: "你好" }));
    });
  });
  const edge = createServer((_req, res) => {
    const audio = Buffer.alloc(4);
    audio.writeInt16LE(1, 0);
    audio.writeInt16LE(2, 2);
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(audio);
  });
  const edgePort = await httpPort(edge);
  const env = {
    HEARTH_ENV: "test",
    HEARTH_LLM_MODE: "mock",
    HEARTH_GATEWAY_PORT: "0",
    HEARTH_GATEWAY_HOST: "127.0.0.1",
    HEARTH_ADMIN_PASSWORD: "test-pass",
    HEARTH_STUN_URL: "",
    HEARTH_ASR_PROVIDER: "dashscope",
    HEARTH_TTS_PROVIDER: "dashscope",
    HEARTH_DASHSCOPE_API_KEY: KEY,
    HEARTH_DASHSCOPE_WS_URL: `ws://127.0.0.1:${dashPort}`,
    HEARTH_VOSK_URL: `ws://127.0.0.1:${voskPort}`,
    HEARTH_TTS_URL: `http://127.0.0.1:${edgePort}/tts`,
    HEARTH_ROLES: "gateway",
    HEARTH_SENTINEL_POLL_MS: "600000",
    DATABASE_URL: "",
    DEEPSEEK_API_KEY: "",
    SIP_ENABLED: "0",
  };
  let running: Awaited<ReturnType<typeof startHearth>> | undefined;
  try {
    const speech = speechProviders(env, (message) => warnings.push(message));
    assert.equal(speech.asrProvider, "dashscope");
    assert.equal(await speech.asr?.transcribe(pcm(20, 1000), 8000), "你好");
    assert.deepEqual([...(await speech.tts?.synthesize("在") ?? [])], [1, 2]);
    assert.match(warnings.join("\n"), /InvalidApiKey/);
    assert.equal(warnings.join("\n").includes(KEY), false);

    let remote = "";
    const session = new VoiceSession({
      asr: speech.asr ?? { transcribe: async () => "" },
      tts: speech.tts ?? { synthesize: async () => new Int16Array() },
      reply: async () => "在",
      onOutbound: () => undefined,
      onEvent: (event) => { if (event.type === "transcript") remote = event.text; },
      frameMs: 0,
      prerollMs: 0,
      minSpeechMs: 20,
      silenceMs: 20,
      backupMs: 30,
    });
    session.pushInbound(pcm(40, 8000));
    session.pushInbound(pcm(40, 0));
    await new Promise((resolve) => setTimeout(resolve, 200));
    session.stop();
    assert.equal(remote, "你好");

    running = await startHearth(env);
    const login = await fetch(`${running.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "test-pass" }),
    }).then((response) => response.json()) as { token: string };
    const voiceConfig = await fetch(`${running.url}/api/voice/config`, { headers: { authorization: `Bearer ${login.token}` } }).then((response) => response.json()) as { asr: boolean; asrProvider: string; ttsProvider: string };
    assert.equal(voiceConfig.asr, true);
    assert.equal(voiceConfig.asrProvider, "dashscope");
    assert.equal(voiceConfig.ttsProvider, "dashscope");
    const pc = new RTCPeerConnection({ codecs: { audio: [usePCMU()] }, iceServers: [] });
    const track = new MediaStreamTrack({ kind: "audio" });
    pc.addTrack(track);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (pc.iceGatheringState !== "complete") await pc.iceGatheringStateChange.watch((state) => state === "complete", 3000).catch(() => undefined);
    const answered = await fetch(`${running.url}/api/voice/calls`, {
      method: "POST",
      headers: { authorization: `Bearer ${login.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sdp: pc.localDescription?.sdp }),
    });
    assert.equal(answered.status, 200);
    const body = await answered.json() as { sdp: string };
    await pc.setRemoteDescription({ type: "answer", sdp: body.sdp });
    await pc.connectionStateChange.watch((state) => state === "connected", 5000);
    const loud = pcmToPayload(Int16Array.from({ length: 160 }, () => 8000), "PCMU");
    const quiet = pcmToPayload(new Int16Array(160), "PCMU");
    let sequence = 1;
    let timestamp = 0;
    const send = (payload: Buffer) => {
      track.writeRtp(new RtpPacket(new RtpHeader({ version: 2, payloadType: 0, sequenceNumber: sequence & 0xffff, timestamp, ssrc: 1 }), payload));
      sequence += 1;
      timestamp += 160;
    };
    for (let i = 0; i < 25; i += 1) send(quiet);
    for (let i = 0; i < 20; i += 1) send(loud);
    for (let i = 0; i < 40; i += 1) send(quiet);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await pc.close();
    const dumped = JSON.stringify(running.store);
    assert.equal(dumped.includes(KEY), false);
    assert.match(dumped, /你好/);
    assert.equal(logs.lines.join("\n").includes(KEY), false);
    assert.equal(warnings.join("\n").includes(KEY), false);
  } finally {
    logs.restore();
    await running?.close();
    await new Promise((resolve) => edge.close(() => resolve(undefined)));
    await new Promise((resolve) => dash.close(() => resolve(undefined)));
    await new Promise((resolve) => vosk.close(() => resolve(undefined)));
  }
});

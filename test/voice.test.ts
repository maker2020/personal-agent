import assert from "node:assert/strict";
import test from "node:test";
import { VoiceSession } from "../packages/telephony/src/voice.js";

test("barge-in cancels playback", async () => {
  const events: string[] = [];
  const session = new VoiceSession({
    asr: { transcribe: async () => "hello" },
    tts: { synthesize: async () => Int16Array.from({ length: 1600 }, () => 1000) },
    reply: async (text) => `echo ${text}`,
    onOutbound: () => undefined,
    onEvent: (event) => events.push(event.type),
    silenceFrames: 1,
    frameMs: 5,
  });
  const loud = Int16Array.from({ length: 160 }, () => 8000);
  const quiet = Int16Array.from({ length: 160 }, () => 0);
  session.pushInbound(loud);
  session.pushInbound(quiet);
  await waitFor(() => events.includes("reply"));
  session.pushInbound(loud);
  await waitFor(() => events.includes("barge-in"));
  assert.ok(events.includes("transcript"));
});

async function waitFor(check: () => boolean): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 2000) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

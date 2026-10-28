import assert from "node:assert/strict";
import test from "node:test";
import { MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket, usePCMU } from "werift";
import { pcmToPayload } from "../packages/telephony/src/g711.js";
import { startHearth } from "../packages/gateway/src/app.js";
import { entitlements } from "../packages/shared/src/entitlements.js";

test("personal plan does not include pstn or sms", () => {
  const personal = entitlements("personal", {});
  assert.equal(personal.voice, true);
  assert.equal(personal.pstn, false);
  assert.equal(personal.sms, false);
  const trial = entitlements("personal", { HEARTH_DEV_PSTN: "1", HEARTH_DEV_SMS: "1" });
  assert.equal(trial.pstn, true);
  assert.equal(trial.sms, true);
  const enterprise = entitlements("enterprise", { PSTN_ENABLED: "1", SMS_ENABLED: "1" });
  assert.equal(enterprise.pstn, true);
  assert.equal(enterprise.dedicatedDid, true);
});

test("in-app webrtc call negotiates PCMU and carries audio", async () => {
  const running = await startHearth({
    ...process.env,
    HEARTH_ENV: "test",
    HEARTH_LLM_MODE: "mock",
    HEARTH_GATEWAY_PORT: "0",
    HEARTH_GATEWAY_HOST: "127.0.0.1",
    HEARTH_ADMIN_PASSWORD: "test-pass",
    HEARTH_STUN_URL: "",
    HEARTH_ROLES: "gateway",
    HEARTH_SENTINEL_POLL_MS: "600000",
    DATABASE_URL: "",
    DEEPSEEK_API_KEY: "",
    SIP_ENABLED: "0",
  });
  const pc = new RTCPeerConnection({ codecs: { audio: [usePCMU()] }, iceServers: [] });
  const track = new MediaStreamTrack({ kind: "audio" });
  pc.addTrack(track);
  let received = 0;
  pc.onTrack.subscribe((incoming) => {
    incoming.onReceiveRtp.subscribe(() => { received += 1; });
  });
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (pc.iceGatheringState !== "complete") {
      await pc.iceGatheringStateChange.watch((state) => state === "complete", 3000).catch(() => undefined);
    }
    const login = await fetch(`${running.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "test-pass" }),
    }).then((response) => response.json()) as { token: string };
    const answered = await fetch(`${running.url}/api/voice/calls`, {
      method: "POST",
      headers: { authorization: `Bearer ${login.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sdp: pc.localDescription?.sdp }),
    });
    assert.equal(answered.status, 200);
    const body = await answered.json() as { id: string; sdp: string };
    assert.match(body.sdp, /PCMU\/8000/);
    await pc.setRemoteDescription({ type: "answer", sdp: body.sdp });
    const connected = await pc.connectionStateChange.watch((state) => state === "connected", 5000).then(() => true).catch(() => false);
    assert.equal(connected, true);
    const loud = pcmToPayload(Int16Array.from({ length: 160 }, () => 8000), "PCMU");
    const quiet = pcmToPayload(new Int16Array(160), "PCMU");
    let sequence = 1;
    let timestamp = 0;
    const send = (payload: Buffer) => {
      track.writeRtp(new RtpPacket(new RtpHeader({ version: 2, payloadType: 0, sequenceNumber: sequence & 0xffff, timestamp, ssrc: 1 }), payload));
      sequence += 1;
      timestamp += 160;
    };
    for (let i = 0; i < 8; i += 1) send(loud);
    send(quiet);
    send(quiet);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const stats = await fetch(`${running.url}/api/voice/calls/${body.id}`, {
      headers: { authorization: `Bearer ${login.token}` },
    }).then((response) => response.json()) as { inbound: number; outbound: number };
    assert.ok(stats.inbound > 0, `expected inbound audio, got ${stats.inbound}`);
    assert.ok(stats.outbound > 0 || received > 0, "expected the agent to send audio back");
  } finally {
    await pc.close();
    await running.close();
  }
});

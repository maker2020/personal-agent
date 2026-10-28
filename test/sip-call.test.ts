import assert from "node:assert/strict";
import dgram from "node:dgram";
import test from "node:test";
import { parseSip, buildSip } from "../packages/telephony/src/sip-message.js";
import { resolveSipConfig } from "../packages/telephony/src/preset.js";
import { SipUserAgent } from "../packages/telephony/src/ua.js";

test("user agent completes an INVITE against a mock trunk", async () => {
  const peer = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => peer.bind(0, "127.0.0.1", () => resolve()));
  const peerPort = peer.address().port;
  peer.on("message", (msg, rinfo) => {
    const parsed = parseSip(msg.toString("utf8"));
    if (parsed.method !== "INVITE") return;
    const headers: Record<string, string> = {};
    for (const name of ["via", "from", "to", "call-id", "cseq"]) {
      const value = parsed.headers[name];
      if (!value) continue;
      const label = name.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("-");
      headers[label] = name === "to" ? `${value};tag=peer` : value;
    }
    headers.Contact = "<sip:peer@127.0.0.1>";
    headers["Content-Type"] = "application/sdp";
    const body = `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=peer\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio ${peerPort} RTP/AVP 8\r\na=rtpmap:8 PCMA/8000\r\n`;
    peer.send(buildSip({ start: "SIP/2.0 200 OK", headers, body }), rinfo.port, rinfo.address);
  });
  const config = resolveSipConfig({
    SIP_PROFILE: "generic",
    SIP_TRUNK_MODE: "ip",
    SIP_PROXY_HOST: "127.0.0.1",
    SIP_PROXY_PORT: String(peerPort),
    SIP_DOMAIN: "127.0.0.1",
    SIP_PUBLIC_IP: "127.0.0.1",
    SIP_SIGNAL_PORT: "0",
    SIP_CALLER_ID: "1000",
    SIP_CODECS: "PCMA",
    SIP_RTP_PORT_MIN: "12000",
    SIP_RTP_PORT_MAX: "12020",
  });
  const ua = new SipUserAgent(config);
  await ua.start();
  const dialog = await ua.invite("10086");
  assert.equal(dialog.state, "confirmed");
  await ua.stop();
  peer.close();
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildSip, parseSip } from "../packages/telephony/src/sip-message.js";
import { digestAuthorization, md5 } from "../packages/telephony/src/digest.js";

test("sip messages round-trip", () => {
  const raw = buildSip({
    start: "INVITE sip:10086@example.com SIP/2.0",
    headers: { From: "<sip:a@example.com>;tag=1", "Call-ID": "abc" },
    body: "v=0",
  });
  const parsed = parseSip(raw);
  assert.equal(parsed.method, "INVITE");
  assert.equal(parsed.headers["call-id"], "abc");
  assert.equal(parsed.body, "v=0");
});

test("digest without qop matches RFC 2617", () => {
  const header = digestAuthorization({
    username: "alice",
    password: "secret",
    method: "REGISTER",
    uri: "sip:example.com",
    challenge: 'Digest realm="example.com", nonce="xyz"',
  });
  const expected = md5(`${md5("alice:example.com:secret")}:xyz:${md5("REGISTER:sip:example.com")}`);
  assert.match(header, new RegExp(`response="${expected}"`));
});

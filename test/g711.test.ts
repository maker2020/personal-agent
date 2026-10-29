import assert from "node:assert/strict";
import test from "node:test";
import { alawToLinear, linearToAlaw, linearToMulaw, mulawToLinear } from "../packages/telephony/src/g711.js";

test("g711 zero samples use the ITU code points", () => {
  assert.equal(linearToAlaw(0), 0xd5);
  assert.equal(linearToMulaw(0), 0xff);
  assert.ok(Math.abs(alawToLinear(linearToAlaw(8000)) - 8000) < 300);
  assert.ok(Math.abs(mulawToLinear(linearToMulaw(-4000)) + 4000) < 300);
});

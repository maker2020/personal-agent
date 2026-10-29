import assert from "node:assert/strict";
import test from "node:test";
import { resolveSipConfig, validateSipConfig } from "../packages/telephony/src/preset.js";

test("aliyun trial and production differ only by config", () => {
  const trial = resolveSipConfig({
    SIP_PROFILE: "aliyun-trial",
    SIP_REGION: "shanghai",
    SIP_USERNAME: "trial-user",
    SIP_PASSWORD: "trial-pass",
    SIP_CALLER_ID: "01012345678",
    SIP_PUBLIC_IP: "203.0.113.10",
  });
  const prod = resolveSipConfig({
    SIP_PROFILE: "aliyun-prod",
    SIP_REGION: "beijing",
    SIP_USERNAME: "leftover",
    SIP_PASSWORD: "leftover",
    SIP_CALLER_ID: "01087654321",
    SIP_PUBLIC_IP: "203.0.113.20",
    SIP_CALLED_PREFIX: "9",
  });
  assert.equal(trial.mode, "register");
  assert.equal(trial.proxyHost, "sh.siptrunk.aliyun.com");
  assert.equal(trial.codecs[0], "PCMA");
  assert.equal(prod.mode, "ip");
  assert.equal(prod.proxyHost, "bj.siptrunk.aliyun.com");
  assert.equal(prod.proxyPort, 5060);
  assert.equal(prod.calledPrefix, "9");
  assert.equal(validateSipConfig(prod).length, 0);
  assert.ok(validateSipConfig({ ...prod, publicIp: "127.0.0.1" }).some((item) => item.includes("SIP_PUBLIC_IP")));
});

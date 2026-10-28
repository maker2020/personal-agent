import assert from "node:assert/strict";
import test from "node:test";
import { startHearth } from "../packages/gateway/src/app.js";
import { apply } from "../packages/dsh-plugin/src/index.js";

test("api chat, sms approval, and aliyun uplink", async () => {
  const running = await startHearth({
    ...process.env,
    HEARTH_ENV: "test",
    HEARTH_LLM_MODE: "mock",
    HEARTH_GATEWAY_PORT: "0",
    HEARTH_GATEWAY_HOST: "127.0.0.1",
    HEARTH_ADMIN_USER: "owner",
    HEARTH_ADMIN_PASSWORD: "test-pass",
    HEARTH_DEV_SMS: "1",
    HEARTH_STUN_URL: "",
    SMS_PROVIDER: "memory",
    SMS_REQUIRE_APPROVAL: "1",
    HEARTH_EMAIL: "memory",
    EMAIL_ENABLED: "1",
    EMAIL_REQUIRE_APPROVAL: "1",
    HEARTH_SENTINEL_POLL_MS: "600000",
    HEARTH_ROLES: "gateway,agent",
    DATABASE_URL: "",
    DEEPSEEK_API_KEY: "",
  });
  try {
    const health = await fetch(`${running.url}/healthz`).then((response) => response.json()) as { ok: boolean };
    assert.equal(health.ok, true);
    const login = await fetch(`${running.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "test-pass" }),
    }).then((response) => response.json()) as { token: string };
    const auth = { authorization: `Bearer ${login.token}`, "content-type": "application/json" };
    const session = await fetch(`${running.url}/api/sessions`, { method: "POST", headers: auth, body: JSON.stringify({ title: "t" }) }).then((response) => response.json()) as { id: string };
    const chat = await fetch(`${running.url}/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "你好" }),
    }).then((response) => response.text());
    assert.match(chat, /收到：你好/);
    await fetch(`${running.url}/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "/tool sms_send {\"to\":\"13800000000\",\"body\":\"hello\"}" }),
    });
    const approvals = await fetch(`${running.url}/api/approvals?status=pending`, { headers: auth }).then((response) => response.json()) as { approvals: Array<{ id: string; kind: string }> };
    const sms = approvals.approvals.find((item) => item.kind === "sms.send");
    assert.ok(sms);
    const decided = await fetch(`${running.url}/api/approvals/${sms.id}/decision`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ decision: "approved" }),
    }).then((response) => response.json()) as { ok: boolean; status: string };
    assert.equal(decided.ok, true);
    const uplink = await fetch(`${running.url}/callbacks/aliyun/sms/up`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ phone_number: "13900000000", content: "在的", send_time: "2026-10-28 10:00:00", dest_code: "9", sequence_id: "seq-1" }]),
    });
    const ack = await uplink.json() as { code: number };
    assert.equal(uplink.status, 200);
    assert.equal(ack.code, 0);
    await fetch(`${running.url}/callbacks/aliyun/sms/up`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ phone_number: "13900000000", content: "在的", send_time: "2026-10-28 10:00:00", dest_code: "9", sequence_id: "seq-1" }]),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const messages = await fetch(`${running.url}/api/sms`, { headers: auth }).then((response) => response.json()) as { messages: Array<{ dedupeKey?: string }> };
    assert.equal(messages.messages.filter((item) => item.dedupeKey === "aliyun:up:seq-1").length, 1);
  } finally {
    await running.close();
  }
});

test("dsh plugin registers hearth tools", () => {
  const names: string[] = [];
  apply({
    tools: {
      register(definition: unknown) {
        names.push((definition as { name: string }).name);
        return () => undefined;
      },
    },
  }, { internalUrl: "http://127.0.0.1:9", internalToken: "t", userId: "owner" });
  assert.ok(names.includes("sms_send"));
  assert.ok(names.includes("email_send"));
  assert.ok(names.includes("phone_call"));
});

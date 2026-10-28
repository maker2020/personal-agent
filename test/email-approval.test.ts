import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { startHearth } from "../packages/gateway/src/app.js";

test("email send waits for approval and then reaches the mailbox", async () => {
  const received: string[] = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    let dataMode = false;
    socket.write("220 mailpit test\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (dataMode) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          received.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          dataMode = false;
          socket.write("250 queued\r\n");
          continue;
        }
        const nl = buffer.indexOf("\r\n");
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        if (/^DATA/i.test(line)) {
          dataMode = true;
          socket.write("354 go ahead\r\n");
        } else if (/^QUIT/i.test(line)) {
          socket.write("221 bye\r\n");
          socket.end();
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const running = await startHearth({
    ...process.env,
    HEARTH_ENV: "test",
    HEARTH_LLM_MODE: "mock",
    HEARTH_GATEWAY_PORT: "0",
    HEARTH_ADMIN_PASSWORD: "test-pass",
    HEARTH_SENTINEL_POLL_MS: "600000",
    HEARTH_ROLES: "gateway",
    HEARTH_STUN_URL: "",
    DATABASE_URL: "",
    DEEPSEEK_API_KEY: "",
    EMAIL_ENABLED: "1",
    EMAIL_REQUIRE_APPROVAL: "1",
    IMAP_HOST: "127.0.0.1",
    IMAP_USER: "owner@example.com",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(port),
    SMTP_SECURE: "0",
    SMTP_FROM: "owner@example.com",
  });
  try {
    const login = await fetch(`${running.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "test-pass" }),
    }).then((response) => response.json()) as { token: string };
    const auth = { authorization: `Bearer ${login.token}`, "content-type": "application/json" };
    const session = await fetch(`${running.url}/api/sessions`, { method: "POST", headers: auth, body: "{}" }).then((response) => response.json()) as { id: string };
    await fetch(`${running.url}/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "/tool email_send {\"to\":\"friend@example.com\",\"subject\":\"Hello mail\",\"text\":\"approved body\"}" }),
    });
    const approvals = await fetch(`${running.url}/api/approvals?status=pending`, { headers: auth }).then((response) => response.json()) as { approvals: Array<{ id: string; kind: string }> };
    const email = approvals.approvals.find((item) => item.kind === "email.send");
    assert.ok(email);
    assert.equal(received.length, 0);
    const decided = await fetch(`${running.url}/api/approvals/${email.id}/decision`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ decision: "approved" }),
    }).then((response) => response.json()) as { status?: string; ok?: boolean };
    assert.equal(decided.status ?? (decided.ok ? "sent" : ""), "sent");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(received.some((item) => item.includes("Subject: Hello mail") && item.includes("approved body")));
  } finally {
    await running.close();
    server.close();
  }
});

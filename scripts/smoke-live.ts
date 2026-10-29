import { startHearth } from "../packages/gateway/src/app.js";

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("DEEPSEEK_API_KEY is not set. Live smoke was not run.");
  process.exit(2);
}

const running = await startHearth({
  ...process.env,
  HEARTH_ENV: "test",
  HEARTH_LLM_MODE: "live",
  HEARTH_GATEWAY_PORT: "0",
  HEARTH_ADMIN_USER: "owner",
  HEARTH_ADMIN_PASSWORD: "live-smoke",
  HEARTH_SENTINEL_POLL_MS: "600000",
  HEARTH_ROLES: "gateway",
  DATABASE_URL: "",
});

try {
  const login = await fetch(`${running.url}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "live-smoke" }),
  });
  if (!login.ok) throw new Error(`login failed (${login.status})`);
  const { token } = await login.json() as { token: string };
  const session = await fetch(`${running.url}/api/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ title: "live" }),
  }).then((response) => response.json()) as { id: string };
  const response = await fetch(`${running.url}/api/sessions/${session.id}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ text: "Reply with exactly this token and nothing else: hearth-ok" }),
  });
  if (!response.ok) throw new Error(`chat failed (${response.status})`);
  const body = await response.text();
  if (!body.includes("hearth-ok")) throw new Error("model reply did not contain the expected token");
  console.log(JSON.stringify({ ok: true, matched: "hearth-ok" }));
} finally {
  await running.close();
}

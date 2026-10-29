import { startHearth } from "../packages/gateway/src/app.js";

const running = await startHearth({
  ...process.env,
  HEARTH_ENV: "test",
  HEARTH_LLM_MODE: "mock",
  HEARTH_GATEWAY_PORT: "0",
  HEARTH_ADMIN_PASSWORD: process.env.HEARTH_ADMIN_PASSWORD ?? "smoke-pass",
  HEARTH_SENTINEL_POLL_MS: "600000",
  DATABASE_URL: "",
});
try {
  const health = await fetch(`${running.url}/healthz`);
  if (!health.ok) throw new Error(`health ${health.status}`);
  const ready = await fetch(`${running.url}/readyz`);
  if (!ready.ok) throw new Error(`ready ${ready.status}`);
  console.log(JSON.stringify({ ok: true, url: running.url }));
} finally {
  await running.close();
}

import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const chrome = process.env.CHROME_PATH ?? "/usr/local/bin/google-chrome";
const port = 9333;
const child = spawn(chrome, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  "--user-data-dir=/tmp/hearth-chrome-profile",
  "--no-sandbox",
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-dev-shm-usage",
  "about:blank",
], { stdio: "ignore" });

async function waitFor(url) {
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch { /* chrome still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("chrome debugging port did not open");
}

const { startHearth } = await import("../dist/packages/gateway/src/app.js");
const running = await startHearth({
  ...process.env,
  HEARTH_ENV: "test",
  HEARTH_LLM_MODE: "mock",
  HEARTH_GATEWAY_PORT: "0",
  HEARTH_GATEWAY_HOST: "127.0.0.1",
  HEARTH_ADMIN_USER: "owner",
  HEARTH_ADMIN_PASSWORD: "browser-pass",
  HEARTH_STUN_URL: "",
  HEARTH_ROLES: "gateway",
  HEARTH_SENTINEL_POLL_MS: "600000",
  HEARTH_SENTINEL_EXTERNAL: "1",
  DATABASE_URL: "",
  DEEPSEEK_API_KEY: "",
  SIP_ENABLED: "0",
});

try {
  const version = await waitFor(`http://127.0.0.1:${port}/json/version`);
  const browser = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve) => browser.once("open", resolve));
  let next = 0;
  const pending = new Map();
  browser.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id && pending.has(message.id)) {
      const done = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) done.reject(new Error(message.error.message));
      else done.resolve(message.result);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    browser.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const target = await send("Target.createTarget", { url: "about:blank" });
  const attached = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
  await send("Page.navigate", { url: running.url }, sessionId);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const evalJs = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  };
  await evalJs(`document.querySelector('input[name=username]').value = 'owner'`);
  await evalJs(`document.querySelector('input[name=password]').value = 'browser-pass'`);
  await evalJs(`document.querySelector('button[type=submit]').click()`);
  for (let i = 0; i < 30; i += 1) {
    const ready = await evalJs(`Boolean(document.querySelector('[data-tab=phone]'))`);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await evalJs(`document.querySelector('[data-tab=phone]').click()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const box = await evalJs(`(() => { const r = document.querySelector('#call').getBoundingClientRect(); return { width: r.width, height: r.height }; })()`);
  if (!box || box.width < 280 || box.height < 48) throw new Error(`call button too small: ${JSON.stringify(box)}`);
  await evalJs(`document.querySelector('#call').click()`);
  let status = "";
  for (let i = 0; i < 40; i += 1) {
    status = await evalJs(`document.getElementById('call-state')?.textContent ?? ''`);
    if (/通话中|已接通|Live|Connected/.test(status ?? "")) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!/通话中|已接通|Live|Connected/.test(status ?? "")) throw new Error(`call did not connect: ${status}`);
  const text = await evalJs(`document.body.innerText`);
  if (!String(text).includes("企业版") && !String(text).includes("enterprise")) throw new Error("missing enterprise notice");
  console.log(JSON.stringify({ ok: true, status, button: box }));
} finally {
  child.kill("SIGKILL");
  await running.close();
}

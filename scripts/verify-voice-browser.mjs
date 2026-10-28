import puppeteer from "puppeteer-core";
import { startHearth } from "../dist/packages/gateway/src/app.js";

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
  DATABASE_URL: "",
  DEEPSEEK_API_KEY: "",
  SIP_ENABLED: "0",
});

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/local/bin/google-chrome",
  headless: true,
  args: [
    "--no-sandbox",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-dev-shm-usage",
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  page.on("pageerror", (error) => {
    console.error(`pageerror ${error.message}`);
  });
  await page.goto(running.url, { waitUntil: "domcontentloaded" });
  await page.type("input[name=username]", "owner");
  await page.type("input[name=password]", "browser-pass");
  await page.click("button[type=submit]");
  await page.waitForSelector("[data-tab=phone]");
  await page.click("[data-tab=phone]");
  await page.waitForSelector("#call");
  const box = await page.$eval("#call", (button) => {
    const rect = button.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  if (box.width < 280 || box.height < 48) throw new Error(`call button is too small for a phone: ${box.width}x${box.height}`);
  await page.click("#call");
  await page.waitForFunction(() => {
    const el = document.getElementById("call-state");
    return Boolean(el && /通话中|已接通|Live|Connected/.test(el.textContent ?? ""));
  }, { timeout: 15000 });
  const status = await page.$eval("#call-state", (el) => el.textContent ?? "");
  const enterpriseCopy = await page.evaluate(() => document.body.innerText.includes("企业版") || document.body.innerText.includes("enterprise"));
  if (!enterpriseCopy) throw new Error("PSTN entitlement copy is missing");
  console.log(JSON.stringify({ ok: true, status, button: box }));
} finally {
  await browser.close();
  await running.close();
}

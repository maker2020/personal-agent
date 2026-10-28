import test from "node:test";

test("live deepseek chat", { skip: !process.env.DEEPSEEK_API_KEY, timeout: 60_000 }, async () => {
  await import("../scripts/smoke-live.js");
});

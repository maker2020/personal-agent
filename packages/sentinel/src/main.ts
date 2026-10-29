import { startSentinel } from "./service.js";

startSentinel().catch((error: unknown) => {
  console.error(JSON.stringify({ level: "error", msg: "sentinel failed", error: error instanceof Error ? error.message : "failed" }));
  process.exit(1);
});

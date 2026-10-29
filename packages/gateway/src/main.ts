import { startHearth } from "./app.js";

startHearth().catch((error: unknown) => {
  console.error(JSON.stringify({ level: "error", msg: "gateway failed", error: error instanceof Error ? error.message : "failed" }));
  process.exit(1);
});

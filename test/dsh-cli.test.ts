import test from "node:test";
import { verifyDsh } from "../scripts/verify-dsh.js";

test("pinned dsh boots and loads the hearth plugin", { timeout: 30_000 }, async () => {
  await verifyDsh();
});

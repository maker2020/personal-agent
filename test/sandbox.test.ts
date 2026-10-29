import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStore } from "../packages/store/src/memory.js";
import { LocalSandbox, PlacementRouter } from "../packages/sandbox/src/index.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("placement stays on the first node", async () => {
  const store = new MemoryStore();
  const root = await mkdtemp(path.join(tmpdir(), "hearth-sbx-"));
  const router = new PlacementRouter(store, "node-a", new LocalSandbox(root), "http://node-a");
  const first = await router.ensure("user-one");
  const again = await router.ensure("user-one");
  assert.equal(first.nodeId, "node-a");
  assert.equal(again.nodeId, "node-a");
  const moved = new PlacementRouter(store, "node-b", new LocalSandbox(root), "http://node-b");
  const sticky = await moved.ensure("user-one");
  assert.equal(sticky.nodeId, "node-a");
  const result = await router.exec("user-one", "printf hello", 5000);
  assert.equal(result.stdout.trim(), "hello");
});

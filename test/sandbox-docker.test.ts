import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { TaskMemory } from "../packages/memory/src/index.js";
import { DockerSandbox, PlacementRouter, dockerRunArgs, runProcess, userWorkspace, volumeBind } from "../packages/sandbox/src/index.js";
import { MemoryStore } from "../packages/store/src/memory.js";
import { invokeTool, type ToolHost } from "../packages/tools/src/registry.js";

test("per-user bind source is the workspace path the manager writes", async () => {
  const workspace = userWorkspace("/var/lib/hearth/workspaces", "user1");
  assert.equal(workspace, "/var/lib/hearth/workspaces/user1");
  assert.equal(volumeBind(workspace), "/var/lib/hearth/workspaces/user1:/workspace");
  const args = dockerRunArgs({ name: "hearth-sbx-user1", userId: "user1", workspace, image: "hearth-sandbox:local" });
  const mount = args[args.indexOf("--mount") + 1];
  assert.equal(mount, "type=bind,source=/var/lib/hearth/workspaces/user1,target=/workspace");
  const compose = await readFile(path.join(process.cwd(), "docker-compose.yml"), "utf8");
  assert.match(compose, /HEARTH_WORKSPACE_ROOT: \$\{HEARTH_WORKSPACE_ROOT:-\/var\/lib\/hearth\/workspaces\}/);
  assert.match(compose, /\$\{HEARTH_WORKSPACE_ROOT:-\/var\/lib\/hearth\/workspaces\}:\$\{HEARTH_WORKSPACE_ROOT:-\/var\/lib\/hearth\/workspaces\}/);
  const pstn = await readFile(path.join(process.cwd(), "docker-compose.pstn.yml"), "utf8");
  assert.match(pstn, /\$\{SIP_SIGNAL_PORT:-5060\}:\$\{SIP_SIGNAL_PORT:-5060\}\/udp/);
  assert.match(pstn, /\$\{SIP_RTP_PORT_MIN:-10000\}-\$\{SIP_RTP_PORT_MAX:-10199\}:\$\{SIP_RTP_PORT_MIN:-10000\}-\$\{SIP_RTP_PORT_MAX:-10199\}\/udp/);
  assert.match(compose, /\$\{HEARTH_HTTP_BIND:-127\.0\.0\.1\}/);
  assert.match(compose, /\$\{HEARTH_HTTP_PORT:-8787\}/);
  assert.match(compose, /\$\{HEARTH_RTC_PORT_MIN:-50000\}-\$\{HEARTH_RTC_PORT_MAX:-50049\}/);
  assert.match(compose, /turnutils_stunclient/);
});

test("a missing docker cli returns an error instead of crashing", async () => {
  const result = await runProcess(["docker", "--version"], process.cwd(), 5000, "/nonexistent");
  assert.equal(result.code, 127);
  assert.match(result.stderr, /spawn docker failed/);
});

function dockerReady(): boolean {
  const info = spawnSync("docker", ["info"], { encoding: "utf8" });
  return info.status === 0;
}

test("sandbox_write is visible to sandbox_exec", { skip: dockerReady() ? false : "docker daemon is not available", timeout: 180_000 }, async () => {
  const image = "hearth-sandbox:test";
  const have = spawnSync("docker", ["image", "inspect", image], { encoding: "utf8" });
  if (have.status !== 0) {
    const build = spawnSync("docker", ["build", "-f", "Dockerfile.sandbox", "-t", image, "."], { encoding: "utf8", cwd: process.cwd() });
    assert.equal(build.status, 0, build.stderr.slice(-2000));
  }
  const root = await mkdtemp(path.join(tmpdir(), "hearth-sbx-"));
  const userId = "dockertest";
  const store = new MemoryStore();
  const router = new PlacementRouter(store, "node-test", new DockerSandbox(root, image), "http://127.0.0.1:8790");
  const host: ToolHost = {
    userId,
    store,
    smsTemplates: {},
    emailRequireApproval: true,
    smsRequireApproval: true,
    phoneRequireApproval: true,
    pstnEnabled: false,
    smsEnabled: false,
    sandbox: router,
    memory: new TaskMemory(new MemorySaver()),
    webAllowPrivate: false,
  };
  try {
    const marker = "hello-from-sandbox-write";
    const wrote = await invokeTool(host, "sandbox_write", { path: "note.txt", content: marker }) as { ok?: boolean };
    assert.equal(wrote.ok, true);
    const read = await invokeTool(host, "sandbox_exec", { command: "echo CONTENT:$(cat note.txt); echo UID:$(id -u); echo FILE:$(stat -c %u:%g note.txt)" }) as { ok?: boolean; stdout?: string; stderr?: string; code?: number };
    assert.equal(read.code, 0, read.stderr);
    assert.match(read.stdout ?? "", new RegExp(`CONTENT:${marker}`));
    assert.match(read.stdout ?? "", /UID:65534/);
    const hostFile = await stat(path.join(root, userId, "note.txt"));
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      assert.match(read.stdout ?? "", /FILE:65534:65534/);
      assert.equal(hostFile.uid, 65534);
      assert.equal(hostFile.gid, 65534);
    }
  } finally {
    spawnSync("docker", ["rm", "-f", `hearth-sbx-${userId}`], { encoding: "utf8" });
    await rm(root, { recursive: true, force: true });
  }
});

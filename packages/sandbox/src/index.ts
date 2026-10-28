import { spawn } from "node:child_process";
import { chmod, chown, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Store } from "../../store/src/types.js";

export type ExecResult = { stdout: string; stderr: string; code: number };

export interface SandboxBackend {
  ensure(userId: string): Promise<{ workspace: string; containerId?: string }>;
  exec(userId: string, command: string, timeoutMs: number): Promise<ExecResult>;
  readFile(userId: string, file: string): Promise<string>;
  writeFile(userId: string, file: string, content: string): Promise<void>;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const SANDBOX_UID = 65534;
export const SANDBOX_GID = 65534;

/** Bind source the host Docker daemon must see. It is the same path the manager writes. */
export function volumeBind(workspace: string): string {
  return `${workspace}:/workspace`;
}

export function dockerRunArgs(input: { name: string; userId: string; workspace: string; image: string; runtime?: string }): string[] {
  const args = ["docker", "run", "-d", "--name", input.name];
  if (input.runtime) args.push("--runtime", input.runtime);
  args.push(
    "--label", `hearth.user=${input.userId}`,
    "--network", "none",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--pids-limit", "64",
    "--memory", "512m",
    "--read-only",
    "--tmpfs", "/tmp",
    "--mount", `type=bind,source=${input.workspace},target=/workspace`,
    "-w", "/workspace",
    input.image,
    "sleep", "infinity",
  );
  return args;
}

export function userWorkspace(root: string, userId: string): string {
  if (!SAFE_ID.test(userId)) throw new Error("unsafe user id");
  const dir = path.resolve(root, userId);
  const base = path.resolve(root);
  if (dir !== base && !dir.startsWith(base + path.sep)) throw new Error("workspace escape");
  return dir;
}

export class LocalSandbox implements SandboxBackend {
  constructor(private root: string) {}
  async ensure(userId: string): Promise<{ workspace: string }> {
    const workspace = userWorkspace(this.root, userId);
    await mkdir(workspace, { recursive: true });
    return { workspace };
  }
  async exec(userId: string, command: string, timeoutMs: number): Promise<ExecResult> {
    const workspace = await this.ensure(userId).then((item) => item.workspace);
    return run(command, workspace, timeoutMs, undefined);
  }
  async readFile(userId: string, file: string): Promise<string> {
    const target = safeFile(await this.ensure(userId).then((item) => item.workspace), file);
    return readFile(target, "utf8");
  }
  async writeFile(userId: string, file: string, content: string): Promise<void> {
    const workspace = await this.ensure(userId).then((item) => item.workspace);
    const target = safeFile(workspace, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

export class DockerSandbox implements SandboxBackend {
  constructor(private root: string, private image: string) {}
  async ensure(userId: string): Promise<{ workspace: string; containerId: string }> {
    const workspace = userWorkspace(this.root, userId);
    await mkdir(workspace, { recursive: true });
    await grantSandboxAccess(workspace, workspace);
    const name = `hearth-sbx-${userId}`;
    if (!(await containerMountMatches(name, workspace))) {
      await runArgv(["docker", "rm", "-f", name], workspace, 15000).catch(() => undefined);
      const runtime = process.env.HEARTH_SANDBOX_RUNTIME;
      const created = await runArgv(dockerRunArgs({ name, userId, workspace, image: this.image, ...(runtime ? { runtime } : {}) }), workspace, 30000);
      if (created.code !== 0) throw new Error(`sandbox start failed: ${created.stderr || created.stdout}`);
    }
    return { workspace, containerId: name };
  }
  async exec(userId: string, command: string, timeoutMs: number): Promise<ExecResult> {
    const env = await this.ensure(userId);
    return runArgv(["docker", "exec", "-u", `${SANDBOX_UID}:${SANDBOX_GID}`, "-w", "/workspace", env.containerId, "bash", "-lc", command], env.workspace, timeoutMs);
  }
  async readFile(userId: string, file: string): Promise<string> {
    return new LocalSandbox(this.root).readFile(userId, file);
  }
  async writeFile(userId: string, file: string, content: string): Promise<void> {
    const workspace = userWorkspace(this.root, userId);
    await mkdir(workspace, { recursive: true });
    const target = safeFile(workspace, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { mode: 0o644 });
    await grantSandboxAccess(workspace, target);
  }
}

export class PlacementRouter {
  constructor(private store: Store, private nodeId: string, private backend: SandboxBackend, private advertiseUrl: string) {}

  async ensure(userId: string): Promise<{ workspace: string; nodeId: string; containerId?: string }> {
    await this.store.upsertNode({ id: this.nodeId, advertiseUrl: this.advertiseUrl, capacity: 2, lastSeenAt: new Date().toISOString() });
    const existing = await this.store.getPlacement(userId);
    if (existing && existing.nodeId !== this.nodeId) {
      return { workspace: existing.workspace, nodeId: existing.nodeId, containerId: existing.containerId };
    }
    const created = await this.backend.ensure(userId);
    if (!existing) {
      await this.store.setPlacement({ userId, nodeId: this.nodeId, workspace: created.workspace, containerId: created.containerId, updatedAt: new Date().toISOString() });
    }
    return { ...created, nodeId: this.nodeId };
  }

  exec(userId: string, command: string, timeoutMs: number): Promise<ExecResult> {
    return this.backend.exec(userId, command, timeoutMs);
  }

  backendRead(userId: string, file: string): Promise<string> {
    return this.backend.readFile(userId, file);
  }

  backendWrite(userId: string, file: string, content: string): Promise<void> {
    return this.backend.writeFile(userId, file, content);
  }
}

function safeFile(workspace: string, file: string): string {
  const target = path.resolve(workspace, file);
  if (target !== workspace && !target.startsWith(workspace + path.sep)) throw new Error("path escape");
  return target;
}

async function grantSandboxOwner(target: string, directory: boolean): Promise<void> {
  try {
    await chown(target, SANDBOX_UID, SANDBOX_GID);
  } catch {
    await chmod(target, directory ? 0o755 : 0o644).catch(() => undefined);
  }
}

async function grantSandboxAccess(workspace: string, target: string): Promise<void> {
  const chain = [workspace];
  let current = workspace;
  const rel = path.relative(workspace, target);
  if (rel && rel !== ".") {
    for (const part of rel.split(path.sep)) {
      current = path.join(current, part);
      chain.push(current);
    }
  }
  for (const entry of chain) {
    const info = await stat(entry);
    await grantSandboxOwner(entry, info.isDirectory());
  }
}

async function containerMountMatches(name: string, workspace: string): Promise<boolean> {
  const inspect = await runArgv(["docker", "inspect", name], workspace, 10000, 200000);
  if (inspect.code !== 0) return false;
  try {
    const parsed = JSON.parse(inspect.stdout) as Array<{ State?: { Running?: boolean }; Mounts?: Array<{ Destination?: string; Source?: string }> }>;
    const info = parsed[0];
    const mount = info?.Mounts?.find((item) => item.Destination === "/workspace");
    return info?.State?.Running === true && mount?.Source === workspace;
  } catch {
    return false;
  }
}

function run(command: string, cwd: string, timeoutMs: number, _env?: NodeJS.ProcessEnv): Promise<ExecResult> {
  return runArgv(["bash", "-lc", command], cwd, timeoutMs);
}

function runArgv(args: string[], cwd: string, timeoutMs: number, max = 20000): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(args[0] ?? "true", args.slice(1), {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: cwd, LANG: "C.UTF-8" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: stdout.slice(0, max), stderr: stderr.slice(0, 8000), code: code ?? 1 });
    });
  });
}

export class RemoteSandbox implements SandboxBackend {
  constructor(private url: string, private token: string) {}
  private async call<T>(pathName: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.url.replace(/\/$/, "")}${pathName}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`sandbox manager ${response.status}`);
    return await response.json() as T;
  }
  ensure(userId: string): Promise<{ workspace: string; containerId?: string }> {
    return this.call("/internal/sandbox/ensure", { userId });
  }
  exec(userId: string, command: string, timeoutMs: number): Promise<ExecResult> {
    return this.call("/internal/sandbox/exec", { userId, command, timeoutMs });
  }
  readFile(userId: string, file: string): Promise<string> {
    return this.call<{ content: string }>("/internal/sandbox/read", { userId, path: file }).then((body) => body.content);
  }
  writeFile(userId: string, file: string, content: string): Promise<void> {
    return this.call("/internal/sandbox/write", { userId, path: file, content }).then(() => undefined);
  }
}

export function selectSandbox(input: { env: string; backend: "local" | "docker"; root: string; image: string; url?: string; token: string }): SandboxBackend {
  if (input.env === "production" && input.backend === "local" && !input.url) {
    throw new Error("LocalSandbox is dev-only and cannot run when HEARTH_ENV=production");
  }
  if (input.url) return new RemoteSandbox(input.url, input.token);
  if (input.backend === "docker") return new DockerSandbox(input.root, input.image);
  return new LocalSandbox(input.root);
}

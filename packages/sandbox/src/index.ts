import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    await run(`chown 65534:65534 ${shellQuote(workspace)}`, workspace, 10000).catch(() => undefined);
    const name = `hearth-sbx-${userId}`;
    await run(`docker inspect ${name}`, workspace, 10000).catch(() => undefined);
    const inspect = await run(`docker inspect -f '{{.State.Running}}' ${name}`, workspace, 10000).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (inspect.code !== 0) {
      const runtime = process.env.HEARTH_SANDBOX_RUNTIME ? `--runtime ${shellQuote(process.env.HEARTH_SANDBOX_RUNTIME)} ` : "";
      await run(
        `docker run -d --name ${name} ${runtime}--label hearth.user=${userId} --network none --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 64 --memory 512m --read-only --tmpfs /tmp -v ${shellQuote(workspace)}:/workspace -w /workspace ${shellQuote(this.image)} sleep infinity`,
        workspace,
        30000,
      );
    }
    return { workspace, containerId: name };
  }
  async exec(userId: string, command: string, timeoutMs: number): Promise<ExecResult> {
    const env = await this.ensure(userId);
    return run(`docker exec -u 65534:65534 -w /workspace ${env.containerId} bash -lc ${shellQuote(command)}`, env.workspace, timeoutMs);
  }
  async readFile(userId: string, file: string): Promise<string> {
    return new LocalSandbox(this.root).readFile(userId, file);
  }
  async writeFile(userId: string, file: string, content: string): Promise<void> {
    await new LocalSandbox(this.root).writeFile(userId, file, content);
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function run(command: string, cwd: string, timeoutMs: number, _env?: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
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
      resolve({ stdout: stdout.slice(0, 20000), stderr: stderr.slice(0, 8000), code: code ?? 1 });
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

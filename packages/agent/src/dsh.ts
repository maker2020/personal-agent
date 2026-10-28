import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

export const DSH_PIN = "0.2.1-rc.2";

export function dshBin(): string {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  const pkg = require.resolve("@deepseek-ai/dsh/package.json");
  return path.join(path.dirname(pkg), "lib", "bin.js");
}

export async function dshVersion(): Promise<string> {
  const result = await run(dshBin(), ["--version"], {});
  return result.stdout.trim();
}

export function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd = process.cwd()): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

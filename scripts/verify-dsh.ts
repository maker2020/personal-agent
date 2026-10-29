import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DSH_PIN, dshBin, dshVersion, run } from "../packages/agent/src/dsh.js";

const root = process.cwd();

export async function verifyDsh(): Promise<void> {
  const version = await dshVersion();
  if (version !== DSH_PIN) throw new Error(`expected dsh ${DSH_PIN}, got ${version || "empty"}`);
  const home = await mkdtemp(path.join(tmpdir(), "hearth-dsh-"));
  const plugin = path.join(root, "dist/packages/dsh-plugin/src/index.js");
  const patch = path.join(home, "hearth.patch.yml");
  await writeFile(patch, `- insert:\n    - id: hearth-tools\n      name: ${plugin}\n`);
  const dumped = await run(process.execPath, [dshBin(), "--profile", "headless", "--patch", patch, "--dump-config"], { DSH_HOME: home }, root);
  if (!dumped.stdout.includes("hearth-tools")) throw new Error(`dump-config missing hearth-tools\n${dumped.stderr}`);
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home };
  delete env.DEEPSEEK_API_KEY;
  const booted = await run(process.execPath, [dshBin(), "--profile", "headless", "--patch", patch, "--", "say hi"], env, root, ["DEEPSEEK_API_KEY"]);
  const combined = `${booted.stdout}\n${booted.stderr}`;
  if (!combined.includes("hearth-plugin-ready")) throw new Error(`plugin did not apply\n${combined}`);
  if (!combined.includes("MISSING_CREDENTIAL")) throw new Error(`expected missing-credential stop without a key\n${combined}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  verifyDsh().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "verify failed");
    process.exit(1);
  });
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.join(process.cwd(), "deploy/install.sh");

function runInstall(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, DEEPSEEK_API_KEY: "", HEARTH_MIRROR: "", HEARTH_DOCKER_REGISTRY_MIRROR: "", ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("dry-run selects the rhel dnf path and writes nothing", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "hearth-dry-"));
  const prefix = path.join(parent, "opt-hearth");
  const sentinel = "sentinel-key-should-not-appear";
  const result = runInstall(["--dry-run", "--noninteractive", "--os", "rhel", "--prefix", prefix, "--deepseek-key", sentinel]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /os family: rhel/);
  assert.match(result.stdout, /dnf/);
  assert.match(result.stdout, /get\.docker\.com/);
  assert.match(result.stdout, /dry-run writes nothing/);
  assert.equal(result.stdout.includes(sentinel), false);
  assert.equal(result.stderr.includes(sentinel), false);
  assert.equal(existsSync(prefix), false);
  assert.equal(existsSync(path.join(prefix, ".env")), false);
});

test("dry-run selects debian and centos 7 paths", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "hearth-os-"));
  const prefix = path.join(parent, "opt-hearth");
  const debian = runInstall(["--dry-run", "--noninteractive", "--os", "debian", "--prefix", prefix]);
  assert.equal(debian.status, 0, debian.stderr);
  assert.match(debian.stdout, /apt/);
  assert.match(debian.stdout, /get\.docker\.com/);
  const china = runInstall(["--dry-run", "--noninteractive", "--os", "debian", "--mirror", "cn", "--prefix", prefix]);
  assert.equal(china.status, 0, china.stderr);
  assert.match(china.stdout, /mirrors\.aliyun\.com\/docker-ce/);
  assert.match(china.stdout, /registry\.npmmirror\.com/);
  assert.match(china.stdout, /HEARTH_APT_MIRROR=https:\/\/mirrors\.aliyun\.com/);
  assert.match(china.stdout, /mirror\.ccs\.tencentyun\.com\//);
  assert.match(china.stdout, /PIP_INDEX_URL=https:\/\/mirrors\.aliyun\.com\/pypi\/simple/);
  assert.match(china.stdout, /hf-mirror\.com\/localstack\/vosk-models/);
  assert.match(china.stdout, /HEARTH_DOCKER_REGISTRY_MIRROR/);
  const refused = runInstall(["--dry-run", "--noninteractive", "--os", "centos7", "--prefix", prefix]);
  assert.equal(refused.status, 1);
  assert.match(`${refused.stdout}\n${refused.stderr}`, /CentOS 7/);
  assert.match(`${refused.stdout}\n${refused.stderr}`, /--mirror cn/);
  const yum = runInstall(["--dry-run", "--noninteractive", "--os", "centos7", "--mirror", "cn", "--prefix", prefix, "--ref", "cursor/hearth-personal-agent-23e9"]);
  assert.equal(yum.status, 0, yum.stderr);
  assert.match(yum.stdout, /yum/);
  assert.match(yum.stdout, /mirrors\.aliyun\.com\/docker-ce\/linux\/centos\/docker-ce\.repo/);
  assert.match(yum.stdout, /git clone --branch cursor\/hearth-personal-agent-23e9/);
  assert.equal(existsSync(prefix), false);
});

test("install.sh keeps an existing POSTGRES_PASSWORD", () => {
  const result = spawnSync("bash", ["-lc", `
set -euo pipefail
source "${script}"
dir=$(mktemp -d)
export ENV_FILE="$dir/.env"
export DRY_RUN=0 DEEPSEEK_KEY_SET=0 DEEPSEEK_KEY= DOMAIN_SET=0 DOMAIN= MIRROR=
hearth_merge_env
pass1=$(grep '^POSTGRES_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
admin1=$(grep '^HEARTH_ADMIN_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
token1=$(grep '^HEARTH_INTERNAL_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
test -n "$pass1"
export DEEPSEEK_KEY_SET=1 DEEPSEEK_KEY=replacement-key MIRROR=cn
hearth_merge_env
pass2=$(grep '^POSTGRES_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
admin2=$(grep '^HEARTH_ADMIN_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
token2=$(grep '^HEARTH_INTERNAL_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
key2=$(grep '^DEEPSEEK_API_KEY=' "$ENV_FILE" | cut -d= -f2-)
npm2=$(grep '^NPM_REGISTRY=' "$ENV_FILE" | cut -d= -f2-)
test "$pass1" = "$pass2"
test "$admin1" = "$admin2"
test "$token1" = "$token2"
test "$key2" = "replacement-key"
test "$npm2" = "https://registry.npmmirror.com"
export DEEPSEEK_KEY_SET=0 DEEPSEEK_KEY= MIRROR=
hearth_merge_env
pass3=$(grep '^POSTGRES_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
key3=$(grep '^DEEPSEEK_API_KEY=' "$ENV_FILE" | cut -d= -f2-)
test "$pass3" = "$pass1"
test "$key3" = "replacement-key"
echo kept
`], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout ?? "", /kept existing POSTGRES_PASSWORD/);
  assert.match(result.stdout ?? "", /kept\n?$/);
});

test("external proxy dry-run prints an nginx vhost and writes nothing", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "hearth-proxy-"));
  const prefix = path.join(parent, "opt-hearth");
  const result = runInstall(["--dry-run", "--noninteractive", "--os", "debian", "--prefix", prefix, "--proxy", "external", "--domain", "agent.example.com", "--http-port", "8787"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /would not start Caddy/);
  assert.match(result.stdout, /proxy_buffering off/);
  assert.match(result.stdout, /proxy_set_header Upgrade/);
  assert.match(result.stdout, /location \/metrics/);
  assert.match(result.stdout, /127\.0\.0\.1:8787/);
  assert.equal(existsSync(prefix), false);
});

test("upgrade compose args keep a local override and skip caddy for an external proxy", () => {
  const result = spawnSync("bash", ["-lc", `
set -euo pipefail
source "${path.join(process.cwd(), "deploy/compose-args.sh")}"
dir=$(mktemp -d)
echo 'services: {}' > "$dir/docker-compose.local.yml"
printf '%s\n' 'HEARTH_DOMAIN=agent.example.com' 'HEARTH_PROXY=external' 'TURN_ENABLED=1' > "$dir/.env"
hearth_compose_arguments "$dir"
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const text = result.stdout ?? "";
  assert.match(text, /docker-compose\.local\.yml/);
  assert.match(text, /--profile\nturn/);
  assert.equal(text.includes("--profile\ntls"), false);
});

test("coturn denies private peers and does not pass removed 4.18 flags", async () => {
  const start = await readFile(path.join(process.cwd(), "deploy/coturn/start.sh"), "utf8");
  assert.equal(start.includes("--no-dtls"), false);
  assert.equal(start.includes("--no-cli"), false);
  assert.match(start, /--denied-peer-ip=10\.0\.0\.0-10\.255\.255\.255/);
  assert.match(start, /--denied-peer-ip=172\.16\.0\.0-172\.31\.255\.255/);
  assert.match(start, /--denied-peer-ip=192\.168\.0\.0-192\.168\.255\.255/);
  assert.match(start, /--denied-peer-ip=127\.0\.0\.0-127\.255\.255\.255/);
  assert.match(start, /--denied-peer-ip=169\.254\.0\.0-169\.254\.255\.255/);
  assert.match(start, /--denied-peer-ip=::1/);
  assert.match(start, /--denied-peer-ip=fc00::/);
  assert.match(start, /--allowed-peer-ip/);
});

test("upgrade fills China speech mirrors without replacing an existing model URL", () => {
  const result = spawnSync("bash", ["-lc", `
set -euo pipefail
source "${path.join(process.cwd(), "deploy/upgrade.sh")}"
dir=$(mktemp -d)
printf '%s\n' 'HEARTH_APT_MIRROR=https://mirrors.aliyun.com' 'HEARTH_IMAGE_PREFIX=mirror.ccs.tencentyun.com/' > "$dir/.env"
hearth_prepare_speech_env "$dir/.env"
grep -q '^PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple$' "$dir/.env"
grep -q '^HEARTH_VOSK_MODEL_URL=https://hf-mirror.com/localstack/vosk-models/resolve/main/vosk-model-small-cn-0.22.zip$' "$dir/.env"
hearth_prepare_speech_env "$dir/.env"
test "$(grep -c '^PIP_INDEX_URL=' "$dir/.env")" -eq 1
printf '%s\n' 'HEARTH_VOSK_MODEL_URL=https://example.test/model.zip' > "$dir/keep.env"
printf '%s\n' 'HEARTH_APT_MIRROR=https://mirrors.aliyun.com' >> "$dir/keep.env"
hearth_prepare_speech_env "$dir/keep.env"
grep -q '^HEARTH_VOSK_MODEL_URL=https://example.test/model.zip$' "$dir/keep.env"
plain=$(mktemp -d)
printf '%s\n' 'HEARTH_DOMAIN=agent.example.com' > "$plain/.env"
hearth_prepare_speech_env "$plain/.env"
test "$(grep -c 'VOSK_MODEL_URL' "$plain/.env")" -eq 0
echo ok
`], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("upgrade retries git pull", () => {
  const result = spawnSync("bash", ["-lc", `
set -euo pipefail
HEARTH_RETRY_DELAY=0
source "${path.join(process.cwd(), "deploy/upgrade.sh")}"
hearth_retry 3 true
if hearth_retry 2 false; then exit 1; fi
n=0
try() { n=$((n + 1)); test "$n" -ge 2; }
hearth_retry 3 try
echo ok
`], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr ?? "", /attempt 1\/2 failed/);
});

test("install.sh prompts for the key with hidden input", async () => {
  const source = await readFile(script, "utf8");
  assert.match(source, /read -r -s -p "DeepSeek API key/);
  assert.match(source, /--ref\|--branch/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHearth } from "../packages/gateway/src/app.js";
import { selectSandbox } from "../packages/sandbox/src/index.js";
import { run } from "../packages/agent/src/dsh.js";
import { MemoryStore } from "../packages/store/src/memory.js";

test("local sandbox is refused in production", () => {
  assert.throws(() => selectSandbox({ env: "production", backend: "local", root: "/tmp", image: "hearth-sandbox:local", token: "t" }), /dev-only/);
});

test("invite signup separates two users", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hearth-users-"));
  const running = await startHearth({
    ...process.env,
    HEARTH_ENV: "test",
    HEARTH_LLM_MODE: "mock",
    HEARTH_GATEWAY_PORT: "0",
    HEARTH_ADMIN_PASSWORD: "test-pass-1",
    HEARTH_SENTINEL_POLL_MS: "600000",
    HEARTH_ROLES: "gateway",
    HEARTH_STUN_URL: "",
    HEARTH_SANDBOX: "local",
    HEARTH_WORKSPACE_ROOT: root,
    DATABASE_URL: "",
    DEEPSEEK_API_KEY: "",
  });
  try {
    const owner = await fetch(`${running.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "test-pass-1" }),
    }).then((response) => response.json()) as { token: string };
    const ownerAuth = { authorization: `Bearer ${owner.token}`, "content-type": "application/json" };
    const invite = await fetch(`${running.url}/api/admin/invites`, { method: "POST", headers: ownerAuth }).then((response) => response.json()) as { code: string };
    const member = await fetch(`${running.url}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "member", password: "member-pass", invite: invite.code }),
    });
    assert.equal(member.status, 200);
    const memberBody = await member.json() as { token: string };
    const memberAuth = { authorization: `Bearer ${memberBody.token}`, "content-type": "application/json" };
    const ownerSession = await fetch(`${running.url}/api/sessions`, { method: "POST", headers: ownerAuth, body: JSON.stringify({ title: "secret" }) }).then((response) => response.json()) as { id: string };
    await fetch(`${running.url}/api/sessions/${ownerSession.id}/messages`, {
      method: "POST",
      headers: ownerAuth,
      body: JSON.stringify({ text: "/tool memory_save {\"text\":\"only-owner\"}" }),
    });
    await fetch(`${running.url}/api/sessions/${ownerSession.id}/messages`, {
      method: "POST",
      headers: ownerAuth,
      body: JSON.stringify({ text: "/tool sandbox_write {\"path\":\"note.txt\",\"content\":\"owner-file\"}" }),
    });
    const memberSession = await fetch(`${running.url}/api/sessions`, { method: "POST", headers: memberAuth, body: JSON.stringify({ title: "mine" }) }).then((response) => response.json()) as { id: string };
    const recall = await fetch(`${running.url}/api/sessions/${memberSession.id}/messages`, {
      method: "POST",
      headers: memberAuth,
      body: JSON.stringify({ text: "/tool memory_recall {}" }),
    }).then((response) => response.text());
    assert.equal(recall.includes("only-owner"), false);
    const stolen = await fetch(`${running.url}/api/sessions/${ownerSession.id}/messages`, { headers: memberAuth });
    assert.equal(stolen.status, 404);
    const users = await fetch(`${running.url}/api/admin/users`, { headers: ownerAuth }).then((response) => response.json()) as { users: Array<{ username: string }> };
    assert.ok(users.users.some((item) => item.username === "member"));
    const forbidden = await fetch(`${running.url}/api/admin/users`, { headers: memberAuth });
    assert.equal(forbidden.status, 403);
  } finally {
    await running.close();
  }
});

test("an invite expires and is consumed once", async () => {
  const store = new MemoryStore();
  const owner = await store.createUser({ username: "owner", passwordHash: "x", role: "owner", plan: "personal" });
  const expired = await store.createInvite(owner.id, new Date(Date.now() - 1000).toISOString());
  const late = await store.createUserFromInvite({ username: "late", passwordHash: "x", inviteCode: expired.code });
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.error, "expired");
  const fresh = await store.createInvite(owner.id, new Date(Date.now() + 3600_000).toISOString());
  const [first, second] = await Promise.all([
    store.createUserFromInvite({ username: "one", passwordHash: "x", inviteCode: fresh.code }),
    store.createUserFromInvite({ username: "two", passwordHash: "x", inviteCode: fresh.code }),
  ]);
  const created = [first, second].filter((item) => item.ok);
  assert.equal(created.length, 1);
  const again = await store.createUserFromInvite({ username: "three", passwordHash: "x", inviteCode: fresh.code });
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.error, "invite_required");
});

test("signup rejects an expired invite and a second use", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hearth-invite-"));
  const expired = await startHearth({
    ...process.env,
    HEARTH_ENV: "test",
    HEARTH_LLM_MODE: "mock",
    HEARTH_GATEWAY_PORT: "0",
    HEARTH_ADMIN_PASSWORD: "test-pass-1",
    HEARTH_SENTINEL_POLL_MS: "600000",
    HEARTH_ROLES: "gateway",
    HEARTH_STUN_URL: "",
    HEARTH_SANDBOX: "local",
    HEARTH_WORKSPACE_ROOT: root,
    HEARTH_INVITE_TTL_HOURS: "-1",
    DATABASE_URL: "",
    DEEPSEEK_API_KEY: "",
  });
  try {
    const owner = await fetch(`${expired.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "test-pass-1" }),
    }).then((response) => response.json()) as { token: string };
    const ownerAuth = { authorization: `Bearer ${owner.token}`, "content-type": "application/json" };
    const invite = await fetch(`${expired.url}/api/admin/invites`, { method: "POST", headers: ownerAuth }).then((response) => response.json()) as { code: string; expiresAt: string };
    assert.ok(Date.parse(invite.expiresAt) <= Date.now());
    const denied = await fetch(`${expired.url}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "lateuser", password: "member-pass", invite: invite.code }),
    });
    assert.equal(denied.status, 403);
    assert.equal(((await denied.json()) as { error: string }).error, "expired");
  } finally {
    await expired.close();
  }

  const live = await startHearth({
    ...process.env,
    HEARTH_ENV: "test",
    HEARTH_LLM_MODE: "mock",
    HEARTH_GATEWAY_PORT: "0",
    HEARTH_ADMIN_PASSWORD: "test-pass-1",
    HEARTH_SENTINEL_POLL_MS: "600000",
    HEARTH_ROLES: "gateway",
    HEARTH_STUN_URL: "",
    HEARTH_SANDBOX: "local",
    HEARTH_WORKSPACE_ROOT: root,
    DATABASE_URL: "",
    DEEPSEEK_API_KEY: "",
  });
  try {
    const owner = await fetch(`${live.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "test-pass-1" }),
    }).then((response) => response.json()) as { token: string };
    const ownerAuth = { authorization: `Bearer ${owner.token}`, "content-type": "application/json" };
    const invite = await fetch(`${live.url}/api/admin/invites`, { method: "POST", headers: ownerAuth }).then((response) => response.json()) as { code: string };
    const first = await fetch(`${live.url}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "member", password: "member-pass", invite: invite.code }),
    });
    assert.equal(first.status, 200);
    const second = await fetch(`${live.url}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "other", password: "member-pass", invite: invite.code }),
    });
    assert.equal(second.status, 403);
    assert.equal(((await second.json()) as { error: string }).error, "invite_required");
  } finally {
    await live.close();
  }
});

test("run() can drop a variable that exists in the parent environment", async () => {
  process.env.HEARTH_UNSET_PROBE = "present";
  try {
    const result = await run(process.execPath, ["-e", "process.stdout.write(process.env.HEARTH_UNSET_PROBE ?? 'unset')"], {}, process.cwd(), ["HEARTH_UNSET_PROBE"]);
    assert.equal(result.stdout, "unset");
  } finally {
    delete process.env.HEARTH_UNSET_PROBE;
  }
});

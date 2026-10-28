import { createRequire } from "node:module";
import { id } from "../../shared/src/ids.js";
import type { Pool } from "pg";
import type {
  Approval,
  AuthSession,
  CallRecord,
  Conversation,
  Message,
  Placement,
  Routine,
  SandboxNode,
  SmsRecord,
  Store,
  User,
} from "./types.js";

const require = createRequire(import.meta.url);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY, username text UNIQUE NOT NULL, password_hash text NOT NULL,
  role text NOT NULL, plan text NOT NULL DEFAULT 'personal', created_at timestamptz NOT NULL);
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'personal';
CREATE TABLE IF NOT EXISTS auth_sessions (
  id text PRIMARY KEY, user_id text NOT NULL, token_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS conversations (
  id text PRIMARY KEY, user_id text NOT NULL, title text NOT NULL, kind text NOT NULL,
  dsh_session_id text, dsh_cwd text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY, conversation_id text NOT NULL, role text NOT NULL, content text NOT NULL,
  tool_calls jsonb, tool_call_id text, created_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (
  id text PRIMARY KEY, user_id text NOT NULL, kind text NOT NULL, status text NOT NULL,
  payload jsonb NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL, decided_at timestamptz);
CREATE TABLE IF NOT EXISTS routines (
  id text PRIMARY KEY, user_id text NOT NULL, name text NOT NULL, schedule text NOT NULL,
  prompt text NOT NULL, enabled boolean NOT NULL, next_run_at timestamptz NOT NULL, last_run_at timestamptz);
CREATE TABLE IF NOT EXISTS calls (
  id text PRIMARY KEY, user_id text NOT NULL, direction text NOT NULL, peer text NOT NULL,
  state text NOT NULL, started_at timestamptz NOT NULL, ended_at timestamptz);
CREATE TABLE IF NOT EXISTS placements (
  user_id text PRIMARY KEY, node_id text NOT NULL, workspace text NOT NULL, container_id text, updated_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS sandbox_nodes (
  id text PRIMARY KEY, advertise_url text NOT NULL, capacity integer NOT NULL, last_seen_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS mail_cursors (
  user_id text NOT NULL, mailbox text NOT NULL, uid bigint NOT NULL, PRIMARY KEY (user_id, mailbox));
CREATE TABLE IF NOT EXISTS telephony_state (
  id text PRIMARY KEY, document jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS invites (
  code text PRIMARY KEY, created_by text NOT NULL, created_at timestamptz NOT NULL, used_by text);
CREATE TABLE IF NOT EXISTS sms_messages (
  id text PRIMARY KEY, user_id text NOT NULL, direction text NOT NULL, provider text NOT NULL,
  peer text NOT NULL, body text NOT NULL, template_code text, status text NOT NULL,
  provider_id text, dedupe_key text UNIQUE, detail jsonb, created_at timestamptz NOT NULL);
`;

type PgPool = Pool;

export class PostgresStore implements Store {
  constructor(private pool: PgPool) {}

  static async open(databaseUrl: string): Promise<PostgresStore> {
    const pg = require("pg") as { Pool: new (config: { connectionString: string; max: number }) => PgPool };
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
    return new PostgresStore(pool);
  }

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA);
  }
  async close(): Promise<void> {
    await this.pool.end();
  }

  async createUser(input: { username: string; passwordHash: string; role: User["role"]; plan?: User["plan"] }): Promise<User> {
    const user: User = { id: id("usr"), username: input.username, passwordHash: input.passwordHash, role: input.role, plan: input.plan ?? "personal", createdAt: new Date().toISOString() };
    await this.pool.query("INSERT INTO users (id, username, password_hash, role, plan, created_at) VALUES ($1,$2,$3,$4,$5,$6)", [user.id, user.username, user.passwordHash, user.role, user.plan, user.createdAt]);
    return user;
  }
  async findUserByUsername(username: string): Promise<User | null> {
    const result = await this.pool.query("SELECT * FROM users WHERE username=$1", [username]);
    return mapUser(result.rows[0]);
  }
  async findUserById(userId: string): Promise<User | null> {
    const result = await this.pool.query("SELECT * FROM users WHERE id=$1", [userId]);
    return mapUser(result.rows[0]);
  }
  async createAuthSession(input: { userId: string; tokenHash: string; expiresAt: string }): Promise<AuthSession> {
    const session: AuthSession = { id: id("ses"), ...input };
    await this.pool.query("INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)", [session.id, session.userId, session.tokenHash, session.expiresAt]);
    return session;
  }
  async findAuthSession(tokenHash: string): Promise<AuthSession | null> {
    const result = await this.pool.query("SELECT * FROM auth_sessions WHERE token_hash=$1", [tokenHash]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return { id: String(row.id), userId: String(row.user_id), tokenHash: String(row.token_hash), expiresAt: iso(row.expires_at) };
  }
  async deleteAuthSession(tokenHash: string): Promise<void> {
    await this.pool.query("DELETE FROM auth_sessions WHERE token_hash=$1", [tokenHash]);
  }
  async createConversation(input: { userId: string; title: string; kind: Conversation["kind"] }): Promise<Conversation> {
    const now = new Date().toISOString();
    const conversation: Conversation = { id: id("cnv"), ...input, createdAt: now, updatedAt: now };
    await this.pool.query("INSERT INTO conversations (id, user_id, title, kind, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6)", [conversation.id, conversation.userId, conversation.title, conversation.kind, now, now]);
    return conversation;
  }
  async listConversations(userId: string): Promise<Conversation[]> {
    const result = await this.pool.query("SELECT * FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC", [userId]);
    return result.rows.map(mapConversation);
  }
  async getConversation(conversationId: string): Promise<Conversation | null> {
    const result = await this.pool.query("SELECT * FROM conversations WHERE id=$1", [conversationId]);
    return result.rows[0] ? mapConversation(result.rows[0]) : null;
  }
  async touchConversation(conversationId: string, patch?: { dshSessionId?: string; dshCwd?: string; title?: string }): Promise<void> {
    await this.pool.query(
      "UPDATE conversations SET updated_at=now(), dsh_session_id=COALESCE($2, dsh_session_id), dsh_cwd=COALESCE($3, dsh_cwd), title=COALESCE($4, title) WHERE id=$1",
      [conversationId, patch?.dshSessionId ?? null, patch?.dshCwd ?? null, patch?.title ?? null],
    );
  }
  async appendMessage(input: Omit<Message, "id" | "createdAt"> & { id?: string }): Promise<Message> {
    const message: Message = { id: input.id ?? id("msg"), conversationId: input.conversationId, role: input.role, content: input.content, createdAt: new Date().toISOString() };
    if (input.toolCalls) message.toolCalls = input.toolCalls;
    if (input.toolCallId) message.toolCallId = input.toolCallId;
    await this.pool.query(
      "INSERT INTO messages (id, conversation_id, role, content, tool_calls, tool_call_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [message.id, message.conversationId, message.role, message.content, message.toolCalls ? JSON.stringify(message.toolCalls) : null, message.toolCallId ?? null, message.createdAt],
    );
    return message;
  }
  async listMessages(conversationId: string): Promise<Message[]> {
    const result = await this.pool.query("SELECT * FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC", [conversationId]);
    return result.rows.map(mapMessage);
  }
  async createApproval(input: Omit<Approval, "id" | "createdAt" | "status"> & { status?: Approval["status"] }): Promise<Approval> {
    const approval: Approval = { id: id("apr"), userId: input.userId, kind: input.kind, status: input.status ?? "pending", payload: input.payload, reason: input.reason, createdAt: new Date().toISOString() };
    await this.pool.query(
      "INSERT INTO approvals (id, user_id, kind, status, payload, reason, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [approval.id, approval.userId, approval.kind, approval.status, JSON.stringify(approval.payload), approval.reason, approval.createdAt],
    );
    return approval;
  }
  async getApproval(approvalId: string): Promise<Approval | null> {
    const result = await this.pool.query("SELECT * FROM approvals WHERE id=$1", [approvalId]);
    return result.rows[0] ? mapApproval(result.rows[0]) : null;
  }
  async listApprovals(userId: string, status?: Approval["status"]): Promise<Approval[]> {
    const result = status
      ? await this.pool.query("SELECT * FROM approvals WHERE user_id=$1 AND status=$2 ORDER BY created_at DESC", [userId, status])
      : await this.pool.query("SELECT * FROM approvals WHERE user_id=$1 ORDER BY created_at DESC", [userId]);
    return result.rows.map(mapApproval);
  }
  async decideApproval(approvalId: string, status: "approved" | "rejected"): Promise<Approval | null> {
    const result = await this.pool.query(
      "UPDATE approvals SET status=$2, decided_at=now() WHERE id=$1 AND status='pending' RETURNING *",
      [approvalId, status],
    );
    if (result.rows[0]) return mapApproval(result.rows[0]);
    return this.getApproval(approvalId);
  }
  async upsertRoutine(input: Omit<Routine, "id"> & { id?: string }): Promise<Routine> {
    const routine: Routine = { id: input.id ?? id("rtn"), userId: input.userId, name: input.name, schedule: input.schedule, prompt: input.prompt, enabled: input.enabled, nextRunAt: input.nextRunAt };
    if (input.lastRunAt) routine.lastRunAt = input.lastRunAt;
    await this.pool.query(
      `INSERT INTO routines (id, user_id, name, schedule, prompt, enabled, next_run_at, last_run_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, schedule=EXCLUDED.schedule, prompt=EXCLUDED.prompt, enabled=EXCLUDED.enabled, next_run_at=EXCLUDED.next_run_at`,
      [routine.id, routine.userId, routine.name, routine.schedule, routine.prompt, routine.enabled, routine.nextRunAt, routine.lastRunAt ?? null],
    );
    return routine;
  }
  async listRoutines(userId: string): Promise<Routine[]> {
    const result = await this.pool.query("SELECT * FROM routines WHERE user_id=$1", [userId]);
    return result.rows.map(mapRoutine);
  }
  async dueRoutines(now: string): Promise<Routine[]> {
    const result = await this.pool.query("SELECT * FROM routines WHERE enabled AND next_run_at <= $1", [now]);
    return result.rows.map(mapRoutine);
  }
  async markRoutineRan(routineId: string, lastRunAt: string, nextRunAt: string): Promise<void> {
    await this.pool.query("UPDATE routines SET last_run_at=$2, next_run_at=$3 WHERE id=$1", [routineId, lastRunAt, nextRunAt]);
  }
  async deleteRoutine(routineId: string, userId: string): Promise<void> {
    await this.pool.query("DELETE FROM routines WHERE id=$1 AND user_id=$2", [routineId, userId]);
  }
  async recordCall(input: Omit<CallRecord, "id"> & { id?: string }): Promise<CallRecord> {
    const call: CallRecord = { id: input.id ?? id("call"), userId: input.userId, direction: input.direction, peer: input.peer, state: input.state, startedAt: input.startedAt };
    if (input.endedAt) call.endedAt = input.endedAt;
    await this.pool.query("INSERT INTO calls (id, user_id, direction, peer, state, started_at, ended_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [call.id, call.userId, call.direction, call.peer, call.state, call.startedAt, call.endedAt ?? null]);
    return call;
  }
  async updateCall(callId: string, patch: Partial<Pick<CallRecord, "state" | "endedAt">>): Promise<void> {
    await this.pool.query("UPDATE calls SET state=COALESCE($2, state), ended_at=COALESCE($3, ended_at) WHERE id=$1", [callId, patch.state ?? null, patch.endedAt ?? null]);
  }
  async listCalls(userId: string): Promise<CallRecord[]> {
    const result = await this.pool.query("SELECT * FROM calls WHERE user_id=$1 ORDER BY started_at DESC", [userId]);
    return result.rows.map((row) => mapCall(row as Record<string, unknown>));
  }
  async setPlacement(input: Placement): Promise<void> {
    await this.pool.query(
      `INSERT INTO placements (user_id, node_id, workspace, container_id, updated_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET node_id=EXCLUDED.node_id, workspace=EXCLUDED.workspace, container_id=EXCLUDED.container_id, updated_at=EXCLUDED.updated_at`,
      [input.userId, input.nodeId, input.workspace, input.containerId ?? null, input.updatedAt],
    );
  }
  async getPlacement(userId: string): Promise<Placement | null> {
    const result = await this.pool.query("SELECT * FROM placements WHERE user_id=$1", [userId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const placement: Placement = { userId: String(row.user_id), nodeId: String(row.node_id), workspace: String(row.workspace), updatedAt: iso(row.updated_at) };
    if (row.container_id) placement.containerId = String(row.container_id);
    return placement;
  }
  async upsertNode(input: SandboxNode): Promise<void> {
    await this.pool.query(
      `INSERT INTO sandbox_nodes (id, advertise_url, capacity, last_seen_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET advertise_url=EXCLUDED.advertise_url, capacity=EXCLUDED.capacity, last_seen_at=EXCLUDED.last_seen_at`,
      [input.id, input.advertiseUrl, input.capacity, input.lastSeenAt],
    );
  }
  async listNodes(): Promise<SandboxNode[]> {
    const result = await this.pool.query("SELECT * FROM sandbox_nodes");
    return result.rows.map((row) => {
      const record = row as Record<string, unknown>;
      return { id: String(record.id), advertiseUrl: String(record.advertise_url), capacity: Number(record.capacity), lastSeenAt: iso(record.last_seen_at) };
    });
  }
  async getMailCursor(userId: string, mailbox: string): Promise<number> {
    const result = await this.pool.query("SELECT uid FROM mail_cursors WHERE user_id=$1 AND mailbox=$2", [userId, mailbox]);
    return Number(result.rows[0]?.uid ?? 0);
  }
  async setMailCursor(userId: string, mailbox: string, uid: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO mail_cursors (user_id, mailbox, uid) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, mailbox) DO UPDATE SET uid=EXCLUDED.uid`,
      [userId, mailbox, uid],
    );
  }
  async getTelephonyState(): Promise<import("./types.js").TelephonyState> {
    const result = await this.pool.query("SELECT document FROM telephony_state WHERE id='default'");
    const document = result.rows[0]?.document as import("./types.js").TelephonyState | undefined;
    return document ?? { dids: [], routes: [], blocks: [], usages: [] };
  }
  async saveTelephonyState(state: import("./types.js").TelephonyState): Promise<void> {
    await this.pool.query(
      `INSERT INTO telephony_state (id, document) VALUES ('default', $1)
       ON CONFLICT (id) DO UPDATE SET document=EXCLUDED.document`,
      [JSON.stringify(state)],
    );
  }
  async findSmsByDedupe(key: string): Promise<SmsRecord | null> {
    const result = await this.pool.query("SELECT * FROM sms_messages WHERE dedupe_key=$1", [key]);
    return result.rows[0] ? mapSms(result.rows[0]) : null;
  }
  async recordSms(input: Omit<SmsRecord, "id" | "createdAt"> & { id?: string }): Promise<SmsRecord> {
    const record: SmsRecord = { id: input.id ?? id("sms"), userId: input.userId, direction: input.direction, provider: input.provider, peer: input.peer, body: input.body, status: input.status, createdAt: new Date().toISOString() };
    if (input.templateCode) record.templateCode = input.templateCode;
    if (input.providerId) record.providerId = input.providerId;
    if (input.dedupeKey) record.dedupeKey = input.dedupeKey;
    if (input.detail) record.detail = input.detail;
    await this.pool.query(
      `INSERT INTO sms_messages (id, user_id, direction, provider, peer, body, template_code, status, provider_id, dedupe_key, detail, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [record.id, record.userId, record.direction, record.provider, record.peer, record.body, record.templateCode ?? null, record.status, record.providerId ?? null, record.dedupeKey ?? null, record.detail ? JSON.stringify(record.detail) : null, record.createdAt],
    );
    return record;
  }
  async updateSms(smsId: string, patch: Partial<Pick<SmsRecord, "status" | "detail" | "providerId">>): Promise<void> {
    await this.pool.query(
      "UPDATE sms_messages SET status=COALESCE($2, status), detail=COALESCE($3, detail), provider_id=COALESCE($4, provider_id) WHERE id=$1",
      [smsId, patch.status ?? null, patch.detail ? JSON.stringify(patch.detail) : null, patch.providerId ?? null],
    );
  }
  async listSms(userId: string): Promise<SmsRecord[]> {
    const result = await this.pool.query("SELECT * FROM sms_messages WHERE user_id=$1 ORDER BY created_at DESC", [userId]);
    return result.rows.map(mapSms);
  }
  async createInvite(createdBy: string): Promise<import("./types.js").Invite> {
    const invite = { code: id("inv").replaceAll("-", "").slice(0, 22), createdBy, createdAt: new Date().toISOString() };
    await this.pool.query("INSERT INTO invites (code, created_by, created_at) VALUES ($1,$2,$3)", [invite.code, invite.createdBy, invite.createdAt]);
    return invite;
  }
  async findInvite(code: string): Promise<import("./types.js").Invite | null> {
    const result = await this.pool.query("SELECT * FROM invites WHERE code=$1", [code]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const invite: import("./types.js").Invite = { code: String(row.code), createdBy: String(row.created_by), createdAt: iso(row.created_at) };
    if (row.used_by) invite.usedBy = String(row.used_by);
    return invite;
  }
  async consumeInvite(code: string, userId: string): Promise<boolean> {
    const result = await this.pool.query("UPDATE invites SET used_by=$2 WHERE code=$1 AND used_by IS NULL RETURNING code", [code, userId]);
    return result.rowCount === 1;
  }
  async listUsers(): Promise<User[]> {
    const result = await this.pool.query("SELECT * FROM users ORDER BY created_at ASC");
    return result.rows.map((row) => mapUser(row as Record<string, unknown>)).filter((user): user is User => user !== null);
  }
  async setUserPlan(userId: string, plan: User["plan"]): Promise<void> {
    await this.pool.query("UPDATE users SET plan=$2 WHERE id=$1", [userId, plan]);
  }
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}
function mapUser(row: Record<string, unknown> | undefined): User | null {
  if (!row) return null;
  return { id: String(row.id), username: String(row.username), passwordHash: String(row.password_hash), role: row.role === "member" ? "member" : "owner", plan: row.plan === "enterprise" ? "enterprise" : "personal", createdAt: iso(row.created_at) };
}
function mapConversation(row: Record<string, unknown>): Conversation {
  const conversation: Conversation = { id: String(row.id), userId: String(row.user_id), title: String(row.title), kind: row.kind === "sentinel" ? "sentinel" : "chat", createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
  if (row.dsh_session_id) conversation.dshSessionId = String(row.dsh_session_id);
  if (row.dsh_cwd) conversation.dshCwd = String(row.dsh_cwd);
  return conversation;
}
function mapMessage(row: Record<string, unknown>): Message {
  const message: Message = { id: String(row.id), conversationId: String(row.conversation_id), role: row.role as Message["role"], content: String(row.content), createdAt: iso(row.created_at) };
  if (row.tool_calls) message.toolCalls = row.tool_calls as Message["toolCalls"];
  if (row.tool_call_id) message.toolCallId = String(row.tool_call_id);
  return message;
}
function mapApproval(row: Record<string, unknown>): Approval {
  const approval: Approval = { id: String(row.id), userId: String(row.user_id), kind: row.kind as Approval["kind"], status: row.status as Approval["status"], payload: (row.payload ?? {}) as Record<string, unknown>, reason: String(row.reason), createdAt: iso(row.created_at) };
  if (row.decided_at) approval.decidedAt = iso(row.decided_at);
  return approval;
}
function mapRoutine(row: Record<string, unknown>): Routine {
  const routine: Routine = { id: String(row.id), userId: String(row.user_id), name: String(row.name), schedule: String(row.schedule), prompt: String(row.prompt), enabled: Boolean(row.enabled), nextRunAt: iso(row.next_run_at) };
  if (row.last_run_at) routine.lastRunAt = iso(row.last_run_at);
  return routine;
}
function mapCall(row: Record<string, unknown>): CallRecord {
  const call: CallRecord = { id: String(row.id), userId: String(row.user_id), direction: row.direction === "in" ? "in" : "out", peer: String(row.peer), state: String(row.state), startedAt: iso(row.started_at) };
  if (row.ended_at) call.endedAt = iso(row.ended_at);
  return call;
}
function mapSms(row: Record<string, unknown>): SmsRecord {
  const record: SmsRecord = { id: String(row.id), userId: String(row.user_id), direction: row.direction === "in" ? "in" : "out", provider: String(row.provider), peer: String(row.peer), body: String(row.body), status: String(row.status), createdAt: iso(row.created_at) };
  if (row.template_code) record.templateCode = String(row.template_code);
  if (row.provider_id) record.providerId = String(row.provider_id);
  if (row.dedupe_key) record.dedupeKey = String(row.dedupe_key);
  if (row.detail && typeof row.detail === "object") record.detail = row.detail as Record<string, unknown>;
  return record;
}

export async function openStore(databaseUrl?: string): Promise<Store> {
  if (!databaseUrl) {
    const { MemoryStore } = await import("./memory.js");
    return new MemoryStore();
  }
  const store = await PostgresStore.open(databaseUrl);
  await store.migrate();
  return store;
}

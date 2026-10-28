import { id } from "../../shared/src/ids.js";
import type {
  Approval,
  AuthSession,
  CallRecord,
  Conversation,
  MailCursor,
  Message,
  Placement,
  Routine,
  SandboxNode,
  SmsRecord,
  Store,
  User,
} from "./types.js";

export class MemoryStore implements Store {
  users: User[] = [];
  sessions: AuthSession[] = [];
  conversations: Conversation[] = [];
  messages: Message[] = [];
  approvals: Approval[] = [];
  routines: Routine[] = [];
  calls: CallRecord[] = [];
  placements: Placement[] = [];
  nodes: SandboxNode[] = [];
  cursors: MailCursor[] = [];
  sms: SmsRecord[] = [];
  telephony: import("./types.js").TelephonyState = { dids: [], routes: [], blocks: [], usages: [] };

  async migrate(): Promise<void> {}
  async close(): Promise<void> {}

  async createUser(input: { username: string; passwordHash: string; role: User["role"]; plan?: User["plan"] }): Promise<User> {
    const user: User = { id: id("usr"), username: input.username, passwordHash: input.passwordHash, role: input.role, plan: input.plan ?? "personal", createdAt: new Date().toISOString() };
    this.users.push(user);
    return user;
  }
  async findUserByUsername(username: string): Promise<User | null> {
    return this.users.find((user) => user.username === username) ?? null;
  }
  async findUserById(userId: string): Promise<User | null> {
    return this.users.find((user) => user.id === userId) ?? null;
  }
  async createAuthSession(input: { userId: string; tokenHash: string; expiresAt: string }): Promise<AuthSession> {
    const session: AuthSession = { id: id("ses"), ...input };
    this.sessions.push(session);
    return session;
  }
  async findAuthSession(tokenHash: string): Promise<AuthSession | null> {
    return this.sessions.find((session) => session.tokenHash === tokenHash) ?? null;
  }
  async deleteAuthSession(tokenHash: string): Promise<void> {
    this.sessions = this.sessions.filter((session) => session.tokenHash !== tokenHash);
  }
  async createConversation(input: { userId: string; title: string; kind: Conversation["kind"] }): Promise<Conversation> {
    const now = new Date().toISOString();
    const conversation: Conversation = { id: id("cnv"), ...input, createdAt: now, updatedAt: now };
    this.conversations.push(conversation);
    return conversation;
  }
  async listConversations(userId: string): Promise<Conversation[]> {
    return this.conversations.filter((item) => item.userId === userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async getConversation(conversationId: string): Promise<Conversation | null> {
    return this.conversations.find((item) => item.id === conversationId) ?? null;
  }
  async touchConversation(conversationId: string, patch?: { dshSessionId?: string; dshCwd?: string; title?: string }): Promise<void> {
    const conversation = this.conversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    conversation.updatedAt = new Date().toISOString();
    if (patch?.dshSessionId) conversation.dshSessionId = patch.dshSessionId;
    if (patch?.dshCwd) conversation.dshCwd = patch.dshCwd;
    if (patch?.title) conversation.title = patch.title;
  }
  async appendMessage(input: Omit<Message, "id" | "createdAt"> & { id?: string }): Promise<Message> {
    const message: Message = { id: input.id ?? id("msg"), conversationId: input.conversationId, role: input.role, content: input.content, createdAt: new Date().toISOString() };
    if (input.toolCalls) message.toolCalls = input.toolCalls;
    if (input.toolCallId) message.toolCallId = input.toolCallId;
    this.messages.push(message);
    return message;
  }
  async listMessages(conversationId: string): Promise<Message[]> {
    return this.messages.filter((item) => item.conversationId === conversationId);
  }
  async createApproval(input: Omit<Approval, "id" | "createdAt" | "status"> & { status?: Approval["status"] }): Promise<Approval> {
    const approval: Approval = { id: id("apr"), userId: input.userId, kind: input.kind, status: input.status ?? "pending", payload: input.payload, reason: input.reason, createdAt: new Date().toISOString() };
    this.approvals.push(approval);
    return approval;
  }
  async getApproval(approvalId: string): Promise<Approval | null> {
    return this.approvals.find((item) => item.id === approvalId) ?? null;
  }
  async listApprovals(userId: string, status?: Approval["status"]): Promise<Approval[]> {
    return this.approvals.filter((item) => item.userId === userId && (!status || item.status === status));
  }
  async decideApproval(approvalId: string, status: "approved" | "rejected"): Promise<Approval | null> {
    const approval = this.approvals.find((item) => item.id === approvalId);
    if (!approval || approval.status !== "pending") return approval ?? null;
    approval.status = status;
    approval.decidedAt = new Date().toISOString();
    return approval;
  }
  async upsertRoutine(input: Omit<Routine, "id"> & { id?: string }): Promise<Routine> {
    const routine: Routine = { id: input.id ?? id("rtn"), userId: input.userId, name: input.name, schedule: input.schedule, prompt: input.prompt, enabled: input.enabled, nextRunAt: input.nextRunAt };
    if (input.lastRunAt) routine.lastRunAt = input.lastRunAt;
    const index = this.routines.findIndex((item) => item.id === routine.id);
    if (index >= 0) this.routines[index] = routine;
    else this.routines.push(routine);
    return routine;
  }
  async listRoutines(userId: string): Promise<Routine[]> {
    return this.routines.filter((item) => item.userId === userId);
  }
  async dueRoutines(now: string): Promise<Routine[]> {
    return this.routines.filter((item) => item.enabled && item.nextRunAt <= now);
  }
  async markRoutineRan(routineId: string, lastRunAt: string, nextRunAt: string): Promise<void> {
    const routine = this.routines.find((item) => item.id === routineId);
    if (!routine) return;
    routine.lastRunAt = lastRunAt;
    routine.nextRunAt = nextRunAt;
  }
  async deleteRoutine(routineId: string, userId: string): Promise<void> {
    this.routines = this.routines.filter((item) => !(item.id === routineId && item.userId === userId));
  }
  async recordCall(input: Omit<CallRecord, "id"> & { id?: string }): Promise<CallRecord> {
    const call: CallRecord = { id: input.id ?? id("call"), userId: input.userId, direction: input.direction, peer: input.peer, state: input.state, startedAt: input.startedAt };
    if (input.endedAt) call.endedAt = input.endedAt;
    this.calls.push(call);
    return call;
  }
  async updateCall(callId: string, patch: Partial<Pick<CallRecord, "state" | "endedAt">>): Promise<void> {
    const call = this.calls.find((item) => item.id === callId);
    if (!call) return;
    if (patch.state) call.state = patch.state;
    if (patch.endedAt) call.endedAt = patch.endedAt;
  }
  async listCalls(userId: string): Promise<CallRecord[]> {
    return this.calls.filter((item) => item.userId === userId);
  }
  async setPlacement(input: Placement): Promise<void> {
    const index = this.placements.findIndex((item) => item.userId === input.userId);
    if (index >= 0) this.placements[index] = input;
    else this.placements.push(input);
  }
  async getPlacement(userId: string): Promise<Placement | null> {
    return this.placements.find((item) => item.userId === userId) ?? null;
  }
  async upsertNode(input: SandboxNode): Promise<void> {
    const index = this.nodes.findIndex((item) => item.id === input.id);
    if (index >= 0) this.nodes[index] = input;
    else this.nodes.push(input);
  }
  async listNodes(): Promise<SandboxNode[]> {
    return [...this.nodes];
  }
  async getMailCursor(userId: string, mailbox: string): Promise<number> {
    return this.cursors.find((item) => item.userId === userId && item.mailbox === mailbox)?.uid ?? 0;
  }
  async setMailCursor(userId: string, mailbox: string, uid: number): Promise<void> {
    const cursor = this.cursors.find((item) => item.userId === userId && item.mailbox === mailbox);
    if (cursor) cursor.uid = uid;
    else this.cursors.push({ userId, mailbox, uid });
  }
  async getTelephonyState(): Promise<import("./types.js").TelephonyState> {
    return structuredClone(this.telephony);
  }
  async saveTelephonyState(state: import("./types.js").TelephonyState): Promise<void> {
    this.telephony = structuredClone(state);
  }
  async findSmsByDedupe(key: string): Promise<SmsRecord | null> {
    return this.sms.find((item) => item.dedupeKey === key) ?? null;
  }
  async recordSms(input: Omit<SmsRecord, "id" | "createdAt"> & { id?: string }): Promise<SmsRecord> {
    const record: SmsRecord = {
      id: input.id ?? id("sms"),
      userId: input.userId,
      direction: input.direction,
      provider: input.provider,
      peer: input.peer,
      body: input.body,
      status: input.status,
      createdAt: new Date().toISOString(),
    };
    if (input.templateCode) record.templateCode = input.templateCode;
    if (input.providerId) record.providerId = input.providerId;
    if (input.dedupeKey) record.dedupeKey = input.dedupeKey;
    if (input.detail) record.detail = input.detail;
    this.sms.push(record);
    return record;
  }
  async updateSms(smsId: string, patch: Partial<Pick<SmsRecord, "status" | "detail" | "providerId">>): Promise<void> {
    const record = this.sms.find((item) => item.id === smsId);
    if (!record) return;
    if (patch.status) record.status = patch.status;
    if (patch.detail) record.detail = patch.detail;
    if (patch.providerId) record.providerId = patch.providerId;
  }
  async listSms(userId: string): Promise<SmsRecord[]> {
    return this.sms.filter((item) => item.userId === userId);
  }
}

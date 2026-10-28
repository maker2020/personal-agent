export type User = {
  id: string;
  username: string;
  passwordHash: string;
  role: "owner" | "member";
  plan: "personal" | "enterprise";
  createdAt: string;
};

export type AuthSession = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
};

export type Conversation = {
  id: string;
  userId: string;
  title: string;
  kind: "chat" | "sentinel";
  dshSessionId?: string;
  dshCwd?: string;
  createdAt: string;
  updatedAt: string;
};

export type ToolCall = { id: string; name: string; input: unknown };

export type Message = {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  createdAt: string;
};

export type ApprovalKind = "email.send" | "phone.outbound" | "sms.send";

export type Approval = {
  id: string;
  userId: string;
  kind: ApprovalKind;
  status: "pending" | "approved" | "rejected";
  payload: Record<string, unknown>;
  reason: string;
  createdAt: string;
  decidedAt?: string;
};

export type Routine = {
  id: string;
  userId: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string;
};

export type CallRecord = {
  id: string;
  userId: string;
  direction: "in" | "out";
  peer: string;
  state: string;
  startedAt: string;
  endedAt?: string;
};

export type Placement = {
  userId: string;
  nodeId: string;
  workspace: string;
  containerId?: string;
  updatedAt: string;
};

export type SandboxNode = {
  id: string;
  advertiseUrl: string;
  capacity: number;
  lastSeenAt: string;
};

export type MailCursor = { userId: string; mailbox: string; uid: number };

export type DidNumber = {
  e164: string;
  role: "shared-main" | "pool";
  status: "available" | "assigned";
  assignedUserId?: string;
  dedicated: boolean;
};

export type InboundRoute = {
  id: string;
  didE164: string;
  mode: "dedicated" | "extension" | "forward";
  userId: string;
  extension?: string;
  forwardFrom?: string;
};

export type CallBlock = { number: string; userId?: string; reason: string };

export type CallUsage = {
  id: string;
  userId: string;
  callId: string;
  direction: "in" | "out";
  purpose: string;
  seconds: number;
  did: string;
  at: string;
};

export type TelephonyState = {
  dids: DidNumber[];
  routes: InboundRoute[];
  blocks: CallBlock[];
  usages: CallUsage[];
};

export type SmsRecord = {
  id: string;
  userId: string;
  direction: "in" | "out";
  provider: string;
  peer: string;
  body: string;
  templateCode?: string;
  status: string;
  providerId?: string;
  dedupeKey?: string;
  detail?: Record<string, unknown>;
  createdAt: string;
};

export type Invite = { code: string; createdBy: string; createdAt: string; usedBy?: string };

export interface Store {
  migrate(): Promise<void>;
  close(): Promise<void>;
  createUser(input: { username: string; passwordHash: string; role: User["role"]; plan?: User["plan"] }): Promise<User>;
  findUserByUsername(username: string): Promise<User | null>;
  findUserById(id: string): Promise<User | null>;
  createAuthSession(input: { userId: string; tokenHash: string; expiresAt: string }): Promise<AuthSession>;
  findAuthSession(tokenHash: string): Promise<AuthSession | null>;
  deleteAuthSession(tokenHash: string): Promise<void>;
  createConversation(input: { userId: string; title: string; kind: Conversation["kind"] }): Promise<Conversation>;
  listConversations(userId: string): Promise<Conversation[]>;
  getConversation(id: string): Promise<Conversation | null>;
  touchConversation(id: string, patch?: { dshSessionId?: string; dshCwd?: string; title?: string }): Promise<void>;
  appendMessage(input: Omit<Message, "id" | "createdAt"> & { id?: string }): Promise<Message>;
  listMessages(conversationId: string): Promise<Message[]>;
  createApproval(input: Omit<Approval, "id" | "createdAt" | "status"> & { status?: Approval["status"] }): Promise<Approval>;
  getApproval(id: string): Promise<Approval | null>;
  listApprovals(userId: string, status?: Approval["status"]): Promise<Approval[]>;
  decideApproval(id: string, status: "approved" | "rejected"): Promise<Approval | null>;
  upsertRoutine(input: Omit<Routine, "id"> & { id?: string }): Promise<Routine>;
  listRoutines(userId: string): Promise<Routine[]>;
  dueRoutines(now: string): Promise<Routine[]>;
  markRoutineRan(id: string, lastRunAt: string, nextRunAt: string): Promise<void>;
  deleteRoutine(id: string, userId: string): Promise<void>;
  recordCall(input: Omit<CallRecord, "id"> & { id?: string }): Promise<CallRecord>;
  updateCall(id: string, patch: Partial<Pick<CallRecord, "state" | "endedAt">>): Promise<void>;
  listCalls(userId: string): Promise<CallRecord[]>;
  setPlacement(input: Placement): Promise<void>;
  getPlacement(userId: string): Promise<Placement | null>;
  upsertNode(input: SandboxNode): Promise<void>;
  listNodes(): Promise<SandboxNode[]>;
  getMailCursor(userId: string, mailbox: string): Promise<number>;
  setMailCursor(userId: string, mailbox: string, uid: number): Promise<void>;
  getTelephonyState(): Promise<TelephonyState>;
  saveTelephonyState(state: TelephonyState): Promise<void>;
  findSmsByDedupe(key: string): Promise<SmsRecord | null>;
  recordSms(input: Omit<SmsRecord, "id" | "createdAt"> & { id?: string }): Promise<SmsRecord>;
  updateSms(id: string, patch: Partial<Pick<SmsRecord, "status" | "detail" | "providerId">>): Promise<void>;
  listSms(userId: string): Promise<SmsRecord[]>;
  createInvite(createdBy: string): Promise<Invite>;
  findInvite(code: string): Promise<Invite | null>;
  consumeInvite(code: string, userId: string): Promise<boolean>;
  listUsers(): Promise<User[]>;
  setUserPlan(id: string, plan: User["plan"]): Promise<void>;
}

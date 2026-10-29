import { id } from "../../shared/src/ids.js";
import type { CallPurpose } from "./compliance.js";
import { evaluateCompliance } from "./compliance.js";
import type { CallUsage, DidNumber, InboundRoute, Store, TelephonyState } from "../../store/src/types.js";

export type TrunkDialer = {
  invite(to: string, from: string): Promise<{ callId: string }>;
  hangup(callId: string): Promise<void>;
};

export type PlaceCallInput = {
  userId: string;
  to: string;
  purpose: CallPurpose;
  consent?: boolean;
  record?: boolean;
};

export type PlaceCallResult =
  | { status: "rejected"; code: string; message: string }
  | { status: "queued"; callId: string; position: number; callerId: string }
  | { status: "dialing"; callId: string; callerId: string };

type Live = {
  id: string;
  userId: string;
  to: string;
  callerId: string;
  purpose: CallPurpose;
  state: "queued" | "dialing" | "active" | "ended";
  startedAt?: number;
  consent: boolean;
  record: boolean;
  pcm: Int16Array[];
  transcript: string[];
};

/**
 * Platform-level PSTN gateway. User agents never see trunk credentials.
 * One Aliyun trunk and one number pool serve every tenant.
 */
export class TelephonyGateway {
  private live = new Map<string, Live>();
  private queue: string[] = [];

  constructor(
    private store: Store,
    private dialer: TrunkDialer | undefined,
    private limits: { trunk: number; perUser: number; perHour: number },
  ) {}

  async seed(numbers: string[], sharedMain?: string): Promise<void> {
    const state = await this.store.getTelephonyState();
    for (const raw of numbers) {
      const e164 = normalize(raw);
      if (!e164 || state.dids.some((did) => did.e164 === e164)) continue;
      state.dids.push({ e164, role: "pool", status: "available", dedicated: false });
    }
    if (sharedMain) {
      const e164 = normalize(sharedMain);
      if (e164 && !state.dids.some((did) => did.e164 === e164)) {
        state.dids.push({ e164, role: "shared-main", status: "assigned", dedicated: false });
      }
    }
    await this.store.saveTelephonyState(state);
  }

  async assignDedicated(userId: string, e164?: string): Promise<DidNumber> {
    const state = await this.store.getTelephonyState();
    const did = e164
      ? state.dids.find((item) => item.e164 === normalize(e164))
      : state.dids.find((item) => item.role === "pool" && item.status === "available");
    if (!did || did.status !== "available") throw new Error("no available DID");
    did.status = "assigned";
    did.assignedUserId = userId;
    did.dedicated = true;
    state.routes.push({ id: id("rte"), didE164: did.e164, mode: "dedicated", userId });
    await this.store.saveTelephonyState(state);
    return did;
  }

  async release(e164: string): Promise<void> {
    const state = await this.store.getTelephonyState();
    const did = state.dids.find((item) => item.e164 === normalize(e164));
    if (!did) return;
    did.status = "available";
    did.dedicated = false;
    delete did.assignedUserId;
    state.routes = state.routes.filter((route) => route.didE164 !== did.e164);
    await this.store.saveTelephonyState(state);
  }

  async addRoute(route: Omit<InboundRoute, "id"> & { id?: string }): Promise<InboundRoute> {
    const state = await this.store.getTelephonyState();
    const saved: InboundRoute = { ...route, id: route.id ?? id("rte"), didE164: normalize(route.didE164) };
    if (route.extension) saved.extension = route.extension;
    if (route.forwardFrom) saved.forwardFrom = normalize(route.forwardFrom);
    state.routes.push(saved);
    await this.store.saveTelephonyState(state);
    return saved;
  }

  async block(number: string, reason: string, userId?: string): Promise<void> {
    const state = await this.store.getTelephonyState();
    state.blocks.push({ number: normalize(number), reason, ...(userId ? { userId } : {}) });
    await this.store.saveTelephonyState(state);
  }

  async routeInbound(input: { did: string; extension?: string; diversion?: string }): Promise<{ userId: string; mode: InboundRoute["mode"] } | { userId: null; reason: string }> {
    const state = await this.store.getTelephonyState();
    const did = normalize(input.did);
    const dedicated = state.routes.find((route) => route.mode === "dedicated" && route.didE164 === did);
    if (dedicated) return { userId: dedicated.userId, mode: "dedicated" };
    if (input.extension) {
      const extension = state.routes.find((route) => route.mode === "extension" && route.didE164 === did && route.extension === input.extension);
      if (extension) return { userId: extension.userId, mode: "extension" };
    }
    if (input.diversion) {
      const diversion = normalize(input.diversion);
      const forwarded = state.routes.find((route) => route.mode === "forward" && route.didE164 === did && route.forwardFrom === diversion);
      if (forwarded) return { userId: forwarded.userId, mode: "forward" };
    }
    return { userId: null, reason: "unrouted" };
  }

  async placeCall(input: PlaceCallInput, now = new Date()): Promise<PlaceCallResult> {
    const state = await this.store.getTelephonyState();
    const callerId = callerFor(state, input.userId);
    if (!callerId) return { status: "rejected", code: "no_caller_id", message: "号码池里没有可用主叫。" };
    const since = now.getTime() - 3600_000;
    const recent = state.usages.filter((usage) => usage.userId === input.userId && usage.direction === "out" && Date.parse(usage.at) >= since).length
      + [...this.live.values()].filter((call) => call.userId === input.userId && call.state !== "ended").length;
    const decision = evaluateCompliance({
      purpose: input.purpose,
      to: input.to,
      now,
      recentCount: recent,
      perUserLimit: this.limits.perHour,
      blocked: state.blocks.some((entry) => entry.number === normalize(input.to) && (!entry.userId || entry.userId === input.userId)),
      consent: Boolean(input.consent),
      recordingRequested: Boolean(input.record),
    });
    if (!decision.ok) return { status: "rejected", code: decision.code, message: decision.message };
    const call: Live = {
      id: id("call"),
      userId: input.userId,
      to: normalize(input.to),
      callerId,
      purpose: input.purpose,
      state: "queued",
      consent: Boolean(input.consent),
      record: Boolean(input.record) && Boolean(input.consent),
      pcm: [],
      transcript: [],
    };
    this.live.set(call.id, call);
    const active = [...this.live.values()].filter((item) => item.state === "dialing" || item.state === "active");
    const mine = active.filter((item) => item.userId === input.userId).length;
    if (active.length >= this.limits.trunk || mine >= this.limits.perUser) {
      this.queue.push(call.id);
      return { status: "queued", callId: call.id, position: this.queue.length, callerId };
    }
    await this.dial(call);
    return { status: "dialing", callId: call.id, callerId };
  }

  async hangup(callId: string, now = new Date()): Promise<void> {
    const call = this.live.get(callId);
    if (!call || call.state === "ended") return;
    await this.dialer?.hangup(callId).catch(() => undefined);
    call.state = "ended";
    const seconds = call.startedAt ? Math.max(1, Math.round((now.getTime() - call.startedAt) / 1000)) : 0;
    const state = await this.store.getTelephonyState();
    const usage: CallUsage = { id: id("use"), userId: call.userId, callId: call.id, direction: "out", purpose: call.purpose, seconds, did: call.callerId, at: now.toISOString() };
    state.usages.push(usage);
    await this.store.saveTelephonyState(state);
    this.queue = this.queue.filter((item) => item !== callId);
    await this.pump();
  }

  snapshot(callId: string): { transcript: string[]; recordingSamples: number; consent: boolean } | undefined {
    const call = this.live.get(callId);
    if (!call) return undefined;
    return { transcript: [...call.transcript], recordingSamples: call.pcm.reduce((sum, frame) => sum + frame.length, 0), consent: call.consent };
  }

  noteTranscript(callId: string, text: string): void {
    this.live.get(callId)?.transcript.push(text);
  }

  recordPcm(callId: string, pcm: Int16Array): void {
    const call = this.live.get(callId);
    if (call?.record) call.pcm.push(pcm);
  }

  private async dial(call: Live): Promise<void> {
    call.state = "dialing";
    call.startedAt = Date.now();
    if (!this.dialer) {
      call.state = "active";
      return;
    }
    const invited = await this.dialer.invite(call.to, call.callerId);
    call.id = invited.callId;
    this.live.set(call.id, call);
    call.state = "active";
  }

  private async pump(): Promise<void> {
    const active = [...this.live.values()].filter((item) => item.state === "dialing" || item.state === "active").length;
    if (active >= this.limits.trunk) return;
    const nextId = this.queue.shift();
    if (!nextId) return;
    const call = this.live.get(nextId);
    if (!call || call.state !== "queued") return;
    await this.dial(call);
  }
}

function callerFor(state: TelephonyState, userId: string): string | undefined {
  const dedicated = state.dids.find((did) => did.dedicated && did.assignedUserId === userId && did.status === "assigned");
  if (dedicated) return dedicated.e164;
  return state.dids.find((did) => did.role === "shared-main")?.e164 ?? state.dids.find((did) => did.status === "available")?.e164;
}

function normalize(value: string): string {
  const digits = value.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  return digits;
}

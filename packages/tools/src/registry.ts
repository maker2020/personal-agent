import type { Store } from "../../store/src/types.js";
import type { Mailbox } from "../../email/src/index.js";
import { requestEmailSend } from "../../email/src/index.js";
import type { SmsChannel } from "../../sms/src/types.js";
import { SmsPolicyError } from "../../sms/src/types.js";
import type { PlacementRouter } from "../../sandbox/src/index.js";
import type { TaskMemory } from "../../memory/src/index.js";
import { fetchWebText } from "./web.js";
import { nextRun } from "../../sentinel/src/schedule.js";

export type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export const TOOL_SPECS: ToolSpec[] = [
  { name: "email_list", description: "List recent inbox messages.", input_schema: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "email_send", description: "Send email. Requires human approval by default.", input_schema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, text: { type: "string" } }, required: ["to", "subject", "text"] } },
  { name: "sms_send", description: "Send SMS. Aliyun requires an approved template code and signature, not free-form text. Requires human approval by default.", input_schema: { type: "object", properties: { to: { type: "string" }, body: { type: "string" }, templateCode: { type: "string" }, templateParams: { type: "object" }, signName: { type: "string" } }, required: ["to"] } },
  { name: "sms_list", description: "List recent SMS messages.", input_schema: { type: "object", properties: {} } },
  { name: "web_fetch", description: "Fetch a public http(s) page as text.", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "sandbox_exec", description: "Run a shell command in the user's private workspace.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "sandbox_read", description: "Read a file from the user's workspace.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "sandbox_write", description: "Write a file in the user's workspace.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "schedule_create", description: "Create a routine. schedule is every:15m, daily:08:00, or cron:M H DOM MON DOW.", input_schema: { type: "object", properties: { name: { type: "string" }, schedule: { type: "string" }, prompt: { type: "string" } }, required: ["name", "schedule", "prompt"] } },
  { name: "schedule_list", description: "List routines.", input_schema: { type: "object", properties: {} } },
  { name: "phone_call", description: "Place an outbound phone call. Requires human approval by default.", input_schema: { type: "object", properties: { to: { type: "string" }, reason: { type: "string" } }, required: ["to"] } },
  { name: "memory_save", description: "Save a note into durable task memory.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "memory_recall", description: "Recall notes from durable task memory.", input_schema: { type: "object", properties: {} } },
];

export type ToolHost = {
  userId: string;
  store: Store;
  mailbox?: Mailbox;
  sms?: SmsChannel;
  smsTemplates: Record<string, string>;
  emailRequireApproval: boolean;
  smsRequireApproval: boolean;
  phoneRequireApproval: boolean;
  pstnEnabled: boolean;
  smsEnabled: boolean;
  sandbox: PlacementRouter;
  memory: TaskMemory;
  webAllowPrivate: boolean;
};

export async function invokeTool(host: ToolHost, name: string, input: Record<string, unknown>): Promise<unknown> {
  try {
    return await dispatch(host, name, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : "tool failed";
    return { ok: false, error: message };
  }
}

async function dispatch(host: ToolHost, name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "email_list": {
      if (!host.mailbox) return { ok: false, error: "email is not configured" };
      const since = await host.store.getMailCursor(host.userId, "INBOX");
      const messages = await host.mailbox.list(since);
      return { ok: true, messages: messages.slice(-(numberArg(input.limit) || 10)) };
    }
    case "email_send": {
      if (!host.mailbox) return { ok: false, error: "email is not configured" };
      return requestEmailSend({
        store: host.store,
        mailbox: host.mailbox,
        userId: host.userId,
        requireApproval: host.emailRequireApproval,
        to: stringArg(input.to),
        subject: stringArg(input.subject),
        text: stringArg(input.text),
      });
    }
    case "sms_send": {
      if (!host.smsEnabled) return { ok: false, error: "sms_not_entitled", message: "短信是企业版能力，当前账号未开通。" };
      if (!host.sms) return { ok: false, error: "sms is not configured" };
      const templateCode = resolveTemplate(stringArg(input.templateCode, ""), host.smsTemplates);
      const body = stringArg(input.body, "");
      if (host.sms.templateOnly && !templateCode) throw new SmsPolicyError("当前短信通道只接受已审核模板，不能发送自由文本。");
      const payload = {
        to: stringArg(input.to),
        body,
        templateCode,
        templateParams: isRecord(input.templateParams) ? input.templateParams : {},
        signName: stringArg(input.signName, ""),
      };
      if (!host.smsRequireApproval) {
        const result = await host.sms.send({
          to: payload.to,
          body: payload.body || undefined,
          templateCode: payload.templateCode || undefined,
          templateParams: payload.templateParams as Record<string, string>,
          signName: payload.signName || undefined,
        });
        await host.store.recordSms({ userId: host.userId, direction: "out", provider: host.sms.id, peer: payload.to, body: payload.body || payload.templateCode, templateCode: payload.templateCode || undefined, status: result.status, providerId: result.providerId });
        return { status: result.status, providerId: result.providerId };
      }
      const approval = await host.store.createApproval({
        userId: host.userId,
        kind: "sms.send",
        payload,
        reason: `发送短信给 ${payload.to}`,
      });
      return { status: "pending", approvalId: approval.id };
    }
    case "sms_list":
      return { ok: true, messages: await host.store.listSms(host.userId) };
    case "web_fetch":
      return { ok: true, ...(await fetchWebText(stringArg(input.url), host.webAllowPrivate)) };
    case "sandbox_exec": {
      await host.sandbox.ensure(host.userId);
      const result = await host.sandbox.exec(host.userId, stringArg(input.command), 15000);
      return { ok: result.code === 0, ...result };
    }
    case "sandbox_read":
      return { ok: true, content: await host.sandbox.backendRead(host.userId, stringArg(input.path)) };
    case "sandbox_write":
      await host.sandbox.backendWrite(host.userId, stringArg(input.path), stringArg(input.content));
      return { ok: true };
    case "schedule_create": {
      const schedule = stringArg(input.schedule);
      const routine = await host.store.upsertRoutine({
        userId: host.userId,
        name: stringArg(input.name),
        schedule,
        prompt: stringArg(input.prompt),
        enabled: true,
        nextRunAt: nextRun(schedule).toISOString(),
      });
      return { ok: true, routine };
    }
    case "schedule_list":
      return { ok: true, routines: await host.store.listRoutines(host.userId) };
    case "phone_call": {
      if (!host.pstnEnabled) return { ok: false, error: "pstn_not_entitled", message: "外呼真实电话是企业版能力，当前账号未开通。和助手通话请使用应用内语音。" };
      const payload = { to: stringArg(input.to), reason: stringArg(input.reason, "") };
      if (!host.phoneRequireApproval) return { status: "approved", ...payload, note: "dial on approval execution" };
      const approval = await host.store.createApproval({ userId: host.userId, kind: "phone.outbound", payload, reason: `拨打电话 ${payload.to}` });
      return { status: "pending", approvalId: approval.id };
    }
    case "memory_save":
      await host.memory.remember(host.userId, stringArg(input.text));
      return { ok: true };
    case "memory_recall":
      return { ok: true, notes: await host.memory.recall(host.userId) };
    default:
      return { ok: false, error: `unknown tool ${name}` };
  }
}

function resolveTemplate(code: string, map: Record<string, string>): string {
  if (!code) return "";
  return map[code] ?? code;
}
function stringArg(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function numberArg(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

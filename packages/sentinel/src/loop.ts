import type { AppConfig } from "../../shared/src/config.js";
import type { Store } from "../../store/src/types.js";
import type { Mailbox } from "../../email/src/index.js";
import { pullAliyunQueue } from "../../sms/src/aliyun.js";
import { parseAliyunSmsReport, parseAliyunSmsUp } from "../../sms/src/aliyun-callback.js";
import type { InboundSms } from "../../sms/src/types.js";
import { nextRun } from "./schedule.js";

export async function sentinelTick(input: {
  config: AppConfig;
  store: Store;
  mailbox?: Mailbox;
  ownerId?: string;
  wake: (userId: string, reason: string, text: string) => Promise<void>;
  now?: Date;
}): Promise<{ routines: number; emails: number; sms: number }> {
  const now = input.now ?? new Date();
  let routines = 0;
  let emails = 0;
  let sms = 0;
  for (const routine of await input.store.dueRoutines(now.toISOString())) {
    routines += 1;
    await input.wake(routine.userId, "routine", routine.prompt);
    await input.store.markRoutineRan(routine.id, now.toISOString(), nextRun(routine.schedule, now).toISOString());
  }
  if (input.mailbox && input.ownerId) {
    const since = await input.store.getMailCursor(input.ownerId, input.config.email.mailbox);
    const messages = await input.mailbox.list(since);
    let maxUid = since;
    for (const message of messages) {
      emails += 1;
      maxUid = Math.max(maxUid, message.uid);
      await input.wake(input.ownerId, "email", `新邮件 来自 ${message.from} 主题 ${message.subject}\n${message.text.slice(0, 500)}`);
    }
    if (maxUid !== since) await input.store.setMailCursor(input.ownerId, input.config.email.mailbox, maxUid);
  }
  const aliyun = input.config.sms.aliyun;
  if (input.config.sms.provider === "aliyun" && aliyun.mnsEnabled && aliyun.accessKeyId && aliyun.accessKeySecret && input.ownerId) {
    const options = { accessKeyId: aliyun.accessKeyId, accessKeySecret: aliyun.accessKeySecret, signName: aliyun.signName ?? "", endpoint: aliyun.endpoint, mnsEndpoint: aliyun.mnsEndpoint };
    if (aliyun.upQueue) {
      for (const body of await pullAliyunQueue(options, "SmsUp", aliyun.upQueue)) {
        const inbound = parseAliyunSmsUp(JSON.parse(body));
        sms += await ingest(input, input.ownerId, inbound);
      }
    }
    if (aliyun.reportQueue) {
      for (const body of await pullAliyunQueue(options, "SmsReport", aliyun.reportQueue)) {
        for (const receipt of parseAliyunSmsReport(JSON.parse(body))) {
          const existing = await input.store.findSmsByDedupe(receipt.dedupeKey);
          if (existing) continue;
          await input.store.recordSms({
            userId: input.ownerId,
            direction: "out",
            provider: "aliyun",
            peer: receipt.to,
            body: receipt.success ? "delivered" : (receipt.errorMessage ?? "failed"),
            status: receipt.success ? "delivered" : "failed",
            providerId: receipt.providerId,
            dedupeKey: receipt.dedupeKey,
            detail: receipt.raw,
          });
        }
      }
    }
  }
  return { routines, emails, sms };
}

async function ingest(input: { store: Store; wake: (userId: string, reason: string, text: string) => Promise<void> }, userId: string, inbound: InboundSms[]): Promise<number> {
  let count = 0;
  for (const message of inbound) {
    if (await input.store.findSmsByDedupe(message.dedupeKey)) continue;
    count += 1;
    await input.store.recordSms({
      userId,
      direction: "in",
      provider: message.provider,
      peer: message.from,
      body: message.body,
      status: "received",
      dedupeKey: message.dedupeKey,
      detail: message.raw,
    });
    await input.wake(userId, "sms", `新短信 来自 ${message.from}\n${message.body}`);
  }
  return count;
}

export { ingest as ingestInboundSms };

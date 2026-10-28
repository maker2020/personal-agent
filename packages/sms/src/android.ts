import type { InboundSms, SmsChannel, SmsSendRequest, SmsSendResult } from "./types.js";
import { SmsPolicyError } from "./types.js";

/**
 * Slot for a future companion handset that relays real P2P SMS.
 * The phone is not the client UI; a small gateway on the device posts inbound
 * messages here and accepts outbound JSON over HTTPS.
 */
export type AndroidGatewayOptions = { url: string; token: string };

export class AndroidSmsGatewayChannel implements SmsChannel {
  readonly id = "android-gateway";
  readonly templateOnly = false;
  constructor(private options: AndroidGatewayOptions, private fetchImpl: typeof fetch = fetch) {}

  async send(input: SmsSendRequest): Promise<SmsSendResult> {
    if (!input.body) throw new SmsPolicyError("Android 短信网关发送的是点对点短信，需要正文 body。");
    const response = await this.fetchImpl(this.options.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ to: input.to, body: input.body, outId: input.outId }),
    });
    if (!response.ok) return { provider: this.id, status: "failed", detail: `gateway HTTP ${response.status}` };
    const payload = await response.json() as { id?: string };
    return { provider: this.id, status: "submitted", providerId: payload.id };
  }
}

export function parseAndroidInbound(payload: unknown): InboundSms {
  if (!payload || typeof payload !== "object") throw new Error("android sms body must be an object");
  const row = payload as Record<string, unknown>;
  const messageId = String(row.id ?? "");
  const from = String(row.from ?? "");
  if (!messageId || !from) throw new Error("android sms missing id or from");
  return {
    provider: "android-gateway",
    dedupeKey: `android:in:${messageId}`,
    from,
    body: String(row.body ?? ""),
    raw: row,
  };
}

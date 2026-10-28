import { createHmac } from "node:crypto";
import type { InboundSms, SmsChannel, SmsSendRequest, SmsSendResult } from "./types.js";
import { SmsPolicyError } from "./types.js";

export type TwilioOptions = { accountSid: string; authToken: string; from: string };

export class TwilioSmsChannel implements SmsChannel {
  readonly id = "twilio";
  readonly templateOnly = false;
  constructor(private options: TwilioOptions, private fetchImpl: typeof fetch = fetch) {}

  async send(input: SmsSendRequest): Promise<SmsSendResult> {
    const body = input.body;
    if (!body) throw new SmsPolicyError("Twilio 发送需要正文 body。");
    const form = new URLSearchParams({ To: input.to, From: this.options.from, Body: body });
    const response = await this.fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${this.options.accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.options.accountSid}:${this.options.authToken}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    const payload = await response.json() as { sid?: string; message?: string };
    if (!response.ok) return { provider: this.id, status: "failed", detail: payload.message ?? `HTTP ${response.status}` };
    return { provider: this.id, status: "submitted", providerId: payload.sid };
  }
}

export function verifyTwilioSignature(url: string, params: Record<string, string>, signature: string, authToken: string): boolean {
  const signed = Object.keys(params).sort().reduce((acc, key) => acc + key + (params[key] ?? ""), url);
  const digest = createHmac("sha1", authToken).update(signed).digest("base64");
  return digest === signature;
}

export function parseTwilioInbound(params: Record<string, string>): InboundSms {
  const sid = params.MessageSid ?? params.SmsSid ?? "";
  if (!sid || !params.From) throw new Error("Twilio inbound missing MessageSid or From");
  return {
    provider: "twilio",
    dedupeKey: `twilio:in:${sid}`,
    from: params.From,
    body: params.Body ?? "",
    raw: params,
  };
}

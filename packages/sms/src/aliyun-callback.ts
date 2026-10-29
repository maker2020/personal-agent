import type { InboundSms, SmsReceipt } from "./types.js";

/** HTTP batch push body for SmsUp. https://help.aliyun.com/zh/sms/developer-reference/smsup-http */
export function parseAliyunSmsUp(payload: unknown): InboundSms[] {
  const items = Array.isArray(payload) ? payload : [payload];
  return items.map((item) => {
    const row = asRecord(item);
    const sequence = String(row.sequence_id ?? "");
    const phone = String(row.phone_number ?? "");
    if (!sequence || !phone) throw new Error("SmsUp item missing sequence_id or phone_number");
    return {
      provider: "aliyun",
      dedupeKey: `aliyun:up:${sequence}`,
      from: phone,
      body: String(row.content ?? ""),
      receivedAt: typeof row.send_time === "string" ? row.send_time : undefined,
      raw: row,
    };
  });
}

/** HTTP batch push body for SmsReport. https://help.aliyun.com/zh/sms/developer-reference/smsreport-http */
export function parseAliyunSmsReport(payload: unknown): SmsReceipt[] {
  const items = Array.isArray(payload) ? payload : [payload];
  return items.map((item) => {
    const row = asRecord(item);
    const bizId = String(row.biz_id ?? "");
    const phone = String(row.phone_number ?? "");
    const reportTime = String(row.report_time ?? "");
    if (!bizId || !phone) throw new Error("SmsReport item missing biz_id or phone_number");
    return {
      provider: "aliyun",
      dedupeKey: `aliyun:report:${bizId}:${phone}:${reportTime}`,
      providerId: bizId,
      to: phone,
      success: row.success === true,
      errorCode: typeof row.err_code === "string" ? row.err_code : undefined,
      errorMessage: typeof row.err_msg === "string" ? row.err_msg : undefined,
      raw: row,
    };
  });
}

export const ALIYUN_SMS_HTTP_ACK = { code: 0, msg: "接收成功" };

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SMS callback item must be an object");
  return value as Record<string, unknown>;
}

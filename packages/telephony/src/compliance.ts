export type CallPurpose = "conversation" | "notification" | "marketing";

export type ComplianceInput = {
  purpose: CallPurpose;
  to: string;
  now: Date;
  recentCount: number;
  perUserLimit: number;
  blocked: boolean;
  consent: boolean;
  recordingRequested: boolean;
};

export type ComplianceResult = { ok: true } | { ok: false; code: string; message: string };

/** Marketing and notification calls use China quiet hours, 08:00–21:00 Asia/Shanghai. */
export function shanghaiHour(now: Date): number {
  const hour = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Asia/Shanghai" }).format(now);
  return Number(hour);
}

export function evaluateCompliance(input: ComplianceInput): ComplianceResult {
  const digits = input.to.replace(/\D/g, "");
  if (digits.length < 5) return { ok: false, code: "bad_number", message: "被叫号码不完整。" };
  if (input.blocked) return { ok: false, code: "do_not_call", message: "号码在禁呼名单中。" };
  if (input.recentCount >= input.perUserLimit) return { ok: false, code: "rate_limit", message: "已超过该用户的呼出频次限制。" };
  if (input.purpose !== "conversation") {
    const hour = shanghaiHour(input.now);
    if (hour < 8 || hour >= 21) return { ok: false, code: "quiet_hours", message: "通知和营销类呼叫仅允许北京时间 08:00–21:00。" };
  }
  if (input.purpose === "marketing" && !input.consent) {
    return { ok: false, code: "consent_required", message: "营销呼叫需要事先同意。" };
  }
  if (input.recordingRequested && !input.consent) {
    return { ok: false, code: "recording_consent_required", message: "录音需要通话双方同意提示。" };
  }
  return { ok: true };
}

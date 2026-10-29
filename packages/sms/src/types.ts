export type SmsSendRequest = {
  to: string;
  body?: string;
  templateCode?: string;
  templateParams?: Record<string, string>;
  signName?: string;
  outId?: string;
};

export type SmsSendResult = {
  provider: string;
  providerId?: string;
  status: "submitted" | "sent" | "failed";
  detail?: string;
};

export type InboundSms = {
  provider: string;
  dedupeKey: string;
  from: string;
  body: string;
  receivedAt?: string;
  raw: Record<string, unknown>;
};

export type SmsReceipt = {
  provider: string;
  dedupeKey: string;
  providerId?: string;
  to: string;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
  raw: Record<string, unknown>;
};

export interface SmsChannel {
  readonly id: string;
  /** True when the provider forbids free-form text (China A2P). */
  readonly templateOnly: boolean;
  send(input: SmsSendRequest): Promise<SmsSendResult>;
}

export class SmsPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmsPolicyError";
  }
}

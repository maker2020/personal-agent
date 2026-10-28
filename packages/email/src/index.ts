import { createRequire } from "node:module";
import type { Store } from "../../store/src/types.js";

const require = createRequire(import.meta.url);

export type MailMessage = {
  uid: number;
  from: string;
  to: string;
  subject: string;
  text: string;
  date?: string;
};

export interface Mailbox {
  list(sinceUid: number): Promise<MailMessage[]>;
  send(input: { to: string; subject: string; text: string }): Promise<void>;
}

export class MemoryMailbox implements Mailbox {
  inbox: MailMessage[] = [];
  sent: Array<{ to: string; subject: string; text: string }> = [];
  async list(sinceUid: number): Promise<MailMessage[]> {
    return this.inbox.filter((message) => message.uid > sinceUid);
  }
  async send(input: { to: string; subject: string; text: string }): Promise<void> {
    this.sent.push(input);
  }
}

export type ImapSmtpOptions = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password?: string;
  accessToken?: string;
  from: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  mailbox: string;
};

export class ImapSmtpMailbox implements Mailbox {
  constructor(private options: ImapSmtpOptions) {}

  async list(sinceUid: number): Promise<MailMessage[]> {
    const { ImapFlow } = require("imapflow") as { ImapFlow: new (opts: unknown) => ImapClient };
    const client = new ImapFlow({
      host: this.options.host,
      port: this.options.port,
      secure: this.options.secure,
      auth: this.options.accessToken
        ? { user: this.options.user, accessToken: this.options.accessToken }
        : { user: this.options.user, pass: this.options.password },
      logger: false,
    });
    await client.connect();
    const lock = await client.getMailboxLock(this.options.mailbox);
    try {
      const range = sinceUid > 0 ? `${sinceUid + 1}:*` : "1:*";
      const messages: MailMessage[] = [];
      for await (const message of client.fetch(range, { envelope: true, source: true, uid: true })) {
        if (!message.uid || message.uid <= sinceUid) continue;
        const envelope = message.envelope;
        messages.push({
          uid: message.uid,
          from: envelope?.from?.[0]?.address ?? "",
          to: envelope?.to?.[0]?.address ?? "",
          subject: envelope?.subject ?? "",
          text: message.source ? message.source.toString("utf8").slice(0, 8000) : "",
          date: envelope?.date ? new Date(envelope.date).toISOString() : undefined,
        });
      }
      return messages;
    } finally {
      lock.release();
      await client.logout();
    }
  }

  async send(input: { to: string; subject: string; text: string }): Promise<void> {
    const nodemailer = require("nodemailer") as { createTransport: (opts: unknown) => { sendMail: (mail: unknown) => Promise<unknown> } };
    const transport = nodemailer.createTransport({
      host: this.options.smtpHost,
      port: this.options.smtpPort,
      secure: this.options.smtpSecure,
      auth: this.options.accessToken
        ? { type: "OAuth2", user: this.options.user, accessToken: this.options.accessToken }
        : { user: this.options.user, pass: this.options.password },
    });
    await transport.sendMail({ from: this.options.from, to: input.to, subject: input.subject, text: input.text });
  }
}

type ImapClient = {
  connect: () => Promise<void>;
  logout: () => Promise<void>;
  getMailboxLock: (mailbox: string) => Promise<{ release: () => void }>;
  fetch: (range: string, query: unknown) => AsyncIterable<{ uid?: number; source?: Buffer; envelope?: { from?: Array<{ address?: string }>; to?: Array<{ address?: string }>; subject?: string; date?: Date } }>;
};

export async function gmailAccessToken(input: { clientId: string; clientSecret: string; refreshToken: string }): Promise<string> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  if (!response.ok) throw new Error(`Gmail token refresh failed (${response.status})`);
  const payload = await response.json() as { access_token?: string };
  if (!payload.access_token) throw new Error("Gmail token refresh returned no access_token");
  return payload.access_token;
}

export async function requestEmailSend(input: {
  store: Store;
  mailbox: Mailbox;
  userId: string;
  requireApproval: boolean;
  to: string;
  subject: string;
  text: string;
}): Promise<{ status: "sent" } | { status: "pending"; approvalId: string }> {
  if (!input.requireApproval) {
    await input.mailbox.send({ to: input.to, subject: input.subject, text: input.text });
    return { status: "sent" };
  }
  const approval = await input.store.createApproval({
    userId: input.userId,
    kind: "email.send",
    payload: { to: input.to, subject: input.subject, text: input.text },
    reason: `发送邮件给 ${input.to}：${input.subject}`,
  });
  return { status: "pending", approvalId: approval.id };
}

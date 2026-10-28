import { loadConfig, createLogger, listen, Router } from "../../shared/src/index.js";
import { openStore } from "../../store/src/index.js";
import { ImapSmtpMailbox, gmailAccessToken, type Mailbox } from "../../email/src/index.js";
import type { AppConfig } from "../../shared/src/config.js";
import { sentinelTick } from "./loop.js";

export async function startSentinel(env: NodeJS.ProcessEnv = process.env): Promise<{ url: string; close: () => Promise<void> }> {
  const config = loadConfig({ ...env, HEARTH_ROLES: "sentinel" });
  const logger = createLogger("sentinel", config.logLevel);
  const store = await openStore(config.databaseUrl);
  await store.migrate();
  const mailbox = await mailboxFrom(config);
  const gateway = env.HEARTH_GATEWAY_URL ?? "http://127.0.0.1:8787";
  const wake = async (userId: string, reason: string, text: string) => {
    const response = await fetch(`${gateway.replace(/\/$/, "")}/internal/wake`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.internalToken}`, "content-type": "application/json" },
      body: JSON.stringify({ userId, reason, text }),
    });
    if (!response.ok) logger.warn("wake failed", { status: response.status, reason });
  };
  const owner = await store.findUserByUsername(config.adminUser);
  const ac = new AbortController();
  let emailIdle = false;
  if (mailbox?.watch && owner) {
    emailIdle = true;
    void mailbox.watch((message) => {
      void wake(owner.id, "email", `新邮件 来自 ${message.from} 主题 ${message.subject}\n${message.text.slice(0, 500)}`);
    }, ac.signal).catch((error: unknown) => {
      emailIdle = false;
      logger.warn("imap idle stopped", { error: error instanceof Error ? error.message : "failed" });
    });
  }
  const timer = setInterval(() => {
    void sentinelTick({
      config,
      store,
      mailbox: emailIdle ? undefined : mailbox,
      ownerId: owner?.id,
      wake,
      skipEmail: emailIdle,
    }).catch((error: unknown) => logger.error("tick", { error: error instanceof Error ? error.message : "failed" }));
  }, config.sentinel.pollMs);
  const router = new Router();
  router.add("GET", "/healthz", async (_req, res) => {
    res.json({ ok: true, service: "sentinel", emailIdle });
  });
  const bound = await listen(router, config.sentinelHost, config.sentinelPort);
  logger.info("sentinel listening", { port: bound.port, emailIdle });
  return {
    url: `http://127.0.0.1:${bound.port}`,
    close: async () => {
      ac.abort();
      clearInterval(timer);
      await new Promise<void>((resolve) => bound.server.close(() => resolve()));
      await store.close();
    },
  };
}

async function mailboxFrom(config: AppConfig): Promise<Mailbox | undefined> {
  if (!config.email.enabled || !config.email.host || !config.email.user) return undefined;
  let accessToken: string | undefined;
  if (config.email.gmailClientId && config.email.gmailClientSecret && config.email.gmailRefreshToken) {
    accessToken = await gmailAccessToken({ clientId: config.email.gmailClientId, clientSecret: config.email.gmailClientSecret, refreshToken: config.email.gmailRefreshToken });
  }
  return new ImapSmtpMailbox({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    user: config.email.user,
    password: config.email.password,
    accessToken,
    from: config.email.from ?? config.email.user,
    smtpHost: config.email.smtpHost ?? config.email.host,
    smtpPort: config.email.smtpPort,
    smtpSecure: config.email.smtpSecure,
    mailbox: config.email.mailbox,
  });
}

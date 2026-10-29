import { readFile } from "node:fs/promises";
import path from "node:path";
import { hashPassword, hashToken, loadConfig, newToken, verifyPassword, createLogger, listen, Router, bearer, authorizedInternal, safeEqual, entitlements, id, type AppConfig } from "../../shared/src/index.js";
import { openStore, type Store } from "../../store/src/index.js";
import { ImapSmtpMailbox, MemoryMailbox, gmailAccessToken, type Mailbox } from "../../email/src/index.js";
import { AliyunSmsChannel, AndroidSmsGatewayChannel, MemorySmsChannel, TwilioSmsChannel, parseAliyunSmsReport, parseAliyunSmsUp, parseAndroidInbound, parseTwilioInbound, verifyTwilioSignature, ALIYUN_SMS_HTTP_ACK, type SmsChannel } from "../../sms/src/index.js";
import { PlacementRouter, selectSandbox } from "../../sandbox/src/index.js";
import { TaskMemory, createCheckpointer } from "../../memory/src/index.js";
import { DeepSeekMessages, MockLlm, type LlmClient } from "../../llm/src/index.js";
import { invokeTool, type ToolHost } from "../../tools/src/registry.js";
import { runTurn } from "../../agent/src/loop.js";
import { dshVersion, DSH_PIN } from "../../agent/src/dsh.js";
import { resolveSipConfig, SipUserAgent, TelephonyGateway, VoiceSession, answerUserVoice, speechProviders, stripMarkdown, SPOKEN_HINT, SpeechProviderError, validateSipConfig, type WebRtcLeg } from "../../telephony/src/index.js";
import { ingestInboundSms, sentinelTick } from "../../sentinel/src/loop.js";
import { Counter, Registry, collectDefaultMetrics } from "prom-client";

export type Running = { url: string; port: number; close: () => Promise<void>; config: AppConfig; store: Store };

export async function startHearth(env: NodeJS.ProcessEnv = process.env): Promise<Running> {
  const config = loadConfig(env);
  const logger = createLogger("hearth", config.logLevel);
  const store = await openStore(config.databaseUrl);
  await store.migrate();
  const owner = await ensureAdmin(store, config);
  const memory = new TaskMemory(await createCheckpointer(config.databaseUrl));
  const backend = selectSandbox({
    env: config.env,
    backend: config.sandbox.backend,
    root: config.sandbox.workspaceRoot,
    image: config.sandbox.dockerImage,
    url: config.sandbox.url,
    token: config.internalToken,
  });
  const sandbox = new PlacementRouter(store, config.sandbox.nodeId, backend, config.sandbox.advertiseUrl);
  const mailbox = await buildMailbox(config, env);
  const sms = buildSms(config, env);
  const llm = buildLlm(config);
  const metrics = new Registry();
  collectDefaultMetrics({ register: metrics });
  const turns = new Counter({ name: "hearth_turns_total", help: "agent turns", registers: [metrics] });
  const wakes = new Counter({ name: "hearth_wakes_total", help: "sentinel wakes", labelNames: ["reason"], registers: [metrics] });
  let dsh = "unavailable";
  try { dsh = await dshVersion(); } catch { dsh = "unavailable"; }

  let ua: SipUserAgent | undefined;
  const pstnPlatform = env.HEARTH_DEV_PSTN === "1" || env.PSTN_ENABLED === "1";
  if (config.roles.has("telephony") && pstnPlatform && env.SIP_ENABLED === "1") {
    const sip = resolveSipConfig(env);
    const errors = validateSipConfig(sip);
    if (errors.length) logger.warn("sip config", { errors });
    else {
      ua = new SipUserAgent(sip);
      await ua.start();
      if (sip.mode === "register") await ua.register().catch((error: unknown) => logger.warn("sip register failed", { error: error instanceof Error ? error.message : "failed" }));
    }
  }
  const telephony = new TelephonyGateway(store, ua ? {
    invite: async (to) => {
      const dialog = await ua!.invite(to);
      return { callId: dialog.callId };
    },
    hangup: async (callId) => { await ua?.hangup(callId); },
  } : undefined, {
    trunk: config.trunkConcurrency,
    perUser: config.userCallConcurrency,
    perHour: config.userCallRatePerHour,
  });
  if (env.SIP_NUMBER_POOL || env.SIP_SHARED_MAIN) {
    await telephony.seed((env.SIP_NUMBER_POOL ?? "").split(",").filter(Boolean), env.SIP_SHARED_MAIN);
  }
  const speech = speechProviders(env, (message) => logger.warn("voice provider", { error: message }));
  const voiceCalls = new Map<string, { inbound: number; outbound: number; leg?: WebRtcLeg; stop?: () => void }>();

  const hostFor = async (userId: string): Promise<ToolHost> => {
    const user = await store.findUserById(userId);
    const features = entitlements(user?.plan, env);
    return {
      userId,
      store,
      mailbox,
      sms: features.sms ? sms : undefined,
      smsTemplates: config.sms.templates,
      emailRequireApproval: config.email.requireApproval,
      smsRequireApproval: config.sms.requireApproval,
      phoneRequireApproval: true,
      pstnEnabled: features.pstn,
      smsEnabled: features.sms,
      sandbox,
      memory,
      webAllowPrivate: config.webAllowPrivate,
    };
  };

  async function wake(userId: string, reason: string, text: string): Promise<void> {
    wakes.inc({ reason });
    const existing = (await store.listConversations(userId)).find((item) => item.kind === "sentinel");
    const conversation = existing ?? await store.createConversation({ userId, title: "守望", kind: "sentinel" });
    turns.inc();
    await runTurn({ store, host: await hostFor(userId), llm, conversationId: conversation.id, text, source: reason });
  }

  async function executeApproval(approvalId: string, userId: string): Promise<unknown> {
    const approval = await store.getApproval(approvalId);
    if (!approval || approval.userId !== userId) return { ok: false, error: "not_found" };
    if (approval.status !== "pending") return { ok: false, error: "not_pending", status: approval.status };
    const decided = await store.decideApproval(approvalId, "approved");
    if (!decided || decided.status !== "approved") return { ok: false, error: "not_pending" };
    if (approval.kind === "email.send" && mailbox) {
      await mailbox.send({ to: String(approval.payload.to ?? ""), subject: String(approval.payload.subject ?? ""), text: String(approval.payload.text ?? "") });
      return { ok: true, status: "sent" };
    }
    if (approval.kind === "sms.send" && sms) {
      const result = await sms.send({
        to: String(approval.payload.to ?? ""),
        body: String(approval.payload.body ?? "") || undefined,
        templateCode: String(approval.payload.templateCode ?? "") || undefined,
        templateParams: (approval.payload.templateParams ?? {}) as Record<string, string>,
        signName: String(approval.payload.signName ?? "") || undefined,
        outId: approval.id,
      });
      await store.recordSms({ userId, direction: "out", provider: sms.id, peer: String(approval.payload.to ?? ""), body: String(approval.payload.body || approval.payload.templateCode || ""), templateCode: String(approval.payload.templateCode ?? "") || undefined, status: result.status, providerId: result.providerId });
      return { ok: true, ...result };
    }
    if (approval.kind === "phone.outbound") {
      const features = entitlements((await store.findUserById(userId))?.plan, env);
      if (!features.pstn) return { ok: false, error: "pstn_not_entitled" };
      const to = String(approval.payload.to ?? "");
      const placed = await telephony.placeCall({ userId, to, purpose: "conversation", consent: true, record: false });
      await store.recordCall({ id: "callId" in placed ? placed.callId : undefined, userId, direction: "out", peer: to, state: placed.status, startedAt: new Date().toISOString() });
      return placed;
    }
    return { ok: false, error: "unsupported" };
  }

  const router = new Router();
  router.add("GET", "/healthz", async (_req, res) => {
    res.json({ ok: true, service: "hearth", dsh, dshPin: DSH_PIN, dshMatchesPin: dsh === DSH_PIN, roles: [...config.roles], llm: config.llm.mode });
  });
  router.add("GET", "/readyz", async (_req, res) => {
    const ready = config.env !== "production" || config.llm.mode === "mock" || Boolean(config.llm.apiKey);
    res.status(ready ? 200 : 503).json({ ok: ready });
  });
  router.add("GET", "/metrics", async (_req, res) => {
    res.text(await metrics.metrics(), "text/plain; version=0.0.4");
  });
  router.add("POST", "/api/auth/login", async (req, res) => {
    const body = record(req.body);
    const user = await store.findUserByUsername(String(body.username ?? ""));
    if (!user || !(await verifyPassword(String(body.password ?? ""), user.passwordHash))) {
      res.status(401).json({ error: "invalid_login" });
      return;
    }
    const token = newToken();
    const expires = new Date(Date.now() + config.sessionTtlHours * 3600_000).toISOString();
    await store.createAuthSession({ userId: user.id, tokenHash: hashToken(token), expiresAt: expires });
    const secure = config.cookieSecure ? "; Secure" : "";
    res.raw.setHeader("set-cookie", `hearth_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${config.sessionTtlHours * 3600}${secure}`);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  });
  router.add("POST", "/api/auth/logout", async (req, res) => {
    const token = sessionToken(req);
    if (token) await store.deleteAuthSession(hashToken(token));
    res.raw.setHeader("set-cookie", "hearth_session=; HttpOnly; Path=/; Max-Age=0");
    res.json({ ok: true });
  });
  router.add("POST", "/api/auth/signup", async (req, res) => {
    const body = record(req.body);
    const username = String(body.username ?? "");
    const password = String(body.password ?? "");
    const inviteCode = String(body.invite ?? "");
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) return res.status(400).json({ error: "bad_username" });
    if (password.length < 8) return res.status(400).json({ error: "weak_password" });
    if (await store.findUserByUsername(username)) return res.status(409).json({ error: "taken" });
    const open = env.HEARTH_OPEN_SIGNUP === "1";
    const created = open
      ? { ok: true as const, user: await store.createUser({ username, passwordHash: await hashPassword(password), role: "member", plan: "personal" }) }
      : await store.createUserFromInvite({ username, passwordHash: await hashPassword(password), inviteCode });
    if (!created.ok) return res.status(403).json({ error: created.error });
    const user = created.user;
    const token = newToken();
    const expires = new Date(Date.now() + config.sessionTtlHours * 3600_000).toISOString();
    await store.createAuthSession({ userId: user.id, tokenHash: hashToken(token), expiresAt: expires });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role, plan: user.plan } });
  });
  router.add("POST", "/api/admin/invites", async (req, res) => {
    const user = await userFrom(req);
    if (!user || user.role !== "owner") return res.status(403).json({ error: "forbidden" });
    const hours = Number(env.HEARTH_INVITE_TTL_HOURS ?? 168);
    const expiresAt = new Date(Date.now() + (Number.isFinite(hours) ? hours : 168) * 3600_000).toISOString();
    res.json(await store.createInvite(user.id, expiresAt));
  });
  router.add("GET", "/api/admin/users", async (req, res) => {
    const user = await userFrom(req);
    if (!user || user.role !== "owner") return res.status(403).json({ error: "forbidden" });
    const users = await store.listUsers();
    res.json({ users: users.map((item) => ({ id: item.id, username: item.username, role: item.role, plan: item.plan })) });
  });
  router.add("POST", "/api/admin/users/:id", async (req, res) => {
    const user = await userFrom(req);
    if (!user || user.role !== "owner") return res.status(403).json({ error: "forbidden" });
    const plan = String(record(req.body).plan ?? "");
    if (plan !== "personal" && plan !== "enterprise") return res.status(400).json({ error: "bad_plan" });
    await store.setUserPlan(req.params.id ?? "", plan);
    res.json({ ok: true });
  });
  router.add("GET", "/api/me", async (req, res) => {
    const user = await userFrom(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    res.json({ id: user.id, username: user.username, role: user.role, ...entitlements(user.plan, env) });
  });
  router.add("GET", "/api/sessions", async (req, res) => {
    const user = await userFrom(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    res.json({ sessions: await store.listConversations(user.id) });
  });
  router.add("POST", "/api/sessions", async (req, res) => {
    const user = await userFrom(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const title = String(record(req.body).title ?? "新对话");
    res.json(await store.createConversation({ userId: user.id, title, kind: "chat" }));
  });
  router.add("GET", "/api/sessions/:id/messages", async (req, res) => {
    const user = await userFrom(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const conversation = await store.getConversation(req.params.id ?? "");
    if (!conversation || conversation.userId !== user.id) return res.status(404).json({ error: "not_found" });
    res.json({ messages: await store.listMessages(conversation.id) });
  });
  router.add("POST", "/api/sessions/:id/messages", async (req, res) => {
    const user = await userFrom(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const conversation = await store.getConversation(req.params.id ?? "");
    if (!conversation || conversation.userId !== user.id) return res.status(404).json({ error: "not_found" });
    const text = String(record(req.body).text ?? "");
    const sse = res.sse();
    turns.inc();
    try {
      const result = await runTurn({ store, host: await hostFor(user.id), llm, conversationId: conversation.id, text, onToken: (token) => sse.send("token", { text: token }) });
      sse.send("done", { text: result.text });
    } catch (error) {
      sse.send("error", { error: error instanceof Error ? error.message : "turn failed" });
    }
    sse.end();
  });
  router.add("GET", "/api/approvals", async (req, res) => {
    const user = await userFrom(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const status = req.query.get("status");
    const filter = status === "pending" || status === "approved" || status === "rejected" ? status : undefined;
    res.json({ approvals: await store.listApprovals(user.id, filter) });
  });
  router.add("POST", "/api/approvals/:id/decision", async (req, res) => {
    const user = await userFrom(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const decision = String(record(req.body).decision ?? "");
    if (decision === "rejected") {
      const updated = await store.decideApproval(req.params.id ?? "", "rejected");
      res.json({ ok: Boolean(updated), approval: updated });
      return;
    }
    if (decision !== "approved") return res.status(400).json({ error: "bad_decision" });
    res.json(await executeApproval(req.params.id ?? "", user.id));
  });
  router.add("GET", "/api/routines", async (req, res) => {
    const user = await userFrom(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    res.json({ routines: await store.listRoutines(user.id) });
  });
  router.add("POST", "/api/routines", async (req, res) => {
    const user = await userFrom(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const body = record(req.body);
    const result = await invokeTool(await hostFor(user.id), "schedule_create", body);
    res.json(result);
  });
  router.add("GET", "/api/calls", async (req, res) => {
    const user = await userFrom(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    res.json({ calls: await store.listCalls(user.id) });
  });
  router.add("GET", "/api/sms", async (req, res) => {
    const user = await userFrom(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    res.json({ messages: await store.listSms(user.id) });
  });
  router.add("GET", "/api/sentinel", async (req, res) => {
    const user = await userFrom(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    res.json({ pollMs: config.sentinel.pollMs, email: config.email.enabled, sms: entitlements(user.plan, env).sms, pstn: entitlements(user.plan, env).pstn, sip: Boolean(ua) });
  });
  router.add("POST", "/internal/wake", async (req, res) => {
    if (!authorizedInternal(req, config.internalToken)) return res.status(401).json({ error: "unauthorized" });
    const body = record(req.body);
    await wake(String(body.userId ?? owner.id), String(body.reason ?? "wake"), String(body.text ?? ""));
    res.json({ ok: true });
  });
  router.add("POST", "/internal/tools/invoke", async (req, res) => {
    if (!authorizedInternal(req, config.internalToken)) return res.status(401).json({ error: "unauthorized" });
    const body = record(req.body);
    const userId = String(body.userId ?? owner.id);
    const result = await invokeTool(await hostFor(userId), String(body.name ?? ""), record(body.input));
    res.json(result);
  });
  router.add("POST", "/callbacks/aliyun/sms/up", async (req, res) => {
    if (!callbackAllowed(req.query.get("token"), config.sms.aliyun.callbackToken)) return res.status(401).json({ error: "unauthorized" });
    try {
      const inbound = parseAliyunSmsUp(req.body);
      void ingestInboundSms({ store, wake }, owner.id, inbound).catch((error: unknown) => logger.error("sms up", { error: error instanceof Error ? error.message : "failed" }));
      res.json(ALIYUN_SMS_HTTP_ACK);
    } catch (error) {
      res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : "failed" });
    }
  });
  router.add("POST", "/callbacks/aliyun/sms/report", async (req, res) => {
    if (!callbackAllowed(req.query.get("token"), config.sms.aliyun.callbackToken)) return res.status(401).json({ error: "unauthorized" });
    try {
      for (const receipt of parseAliyunSmsReport(req.body)) {
        if (await store.findSmsByDedupe(receipt.dedupeKey)) continue;
        await store.recordSms({ userId: owner.id, direction: "out", provider: "aliyun", peer: receipt.to, body: receipt.errorMessage ?? (receipt.success ? "delivered" : "failed"), status: receipt.success ? "delivered" : "failed", providerId: receipt.providerId, dedupeKey: receipt.dedupeKey, detail: receipt.raw });
      }
      res.json(ALIYUN_SMS_HTTP_ACK);
    } catch (error) {
      res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : "failed" });
    }
  });
  router.add("POST", "/callbacks/twilio/sms", async (req, res) => {
    const params = record(req.body) as Record<string, string>;
    const signature = String(req.headers["x-twilio-signature"] ?? "");
    if (config.sms.twilio.authToken) {
      const url = `${config.publicUrl}/callbacks/twilio/sms`;
      if (!verifyTwilioSignature(url, params, signature, config.sms.twilio.authToken)) return res.status(401).json({ error: "bad_signature" });
    }
    const inbound = parseTwilioInbound(params);
    void ingestInboundSms({ store, wake }, owner.id, [inbound]);
    res.text("<Response></Response>", "text/xml");
  });
  router.add("POST", "/callbacks/android-sms", async (req, res) => {
    const token = bearer(req) ?? "";
    if (!config.sms.android.token || !safeEqual(token, config.sms.android.token)) return res.status(401).json({ error: "unauthorized" });
    const inbound = parseAndroidInbound(req.body);
    await ingestInboundSms({ store, wake }, owner.id, [inbound]);
    res.json({ ok: true });
  });
  router.add("GET", "/api/voice/config", async (req, res) => {
    const user = await userFrom(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    res.json({ iceServers: config.iceServers, codec: "PCMU", asr: speech.asrEnabled, tts: speech.ttsEnabled, asrProvider: speech.asrProvider, ttsProvider: speech.ttsProvider });
  });
  router.add("POST", "/api/voice/calls", async (req, res) => {
    const user = await userFrom(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const sdp = String(record(req.body).sdp ?? "");
    const callId = id("voice");
    const conversation = await store.createConversation({ userId: user.id, title: "语音", kind: "chat" });
    const stats = { inbound: 0, outbound: 0, leg: undefined as WebRtcLeg | undefined, stop: undefined as (() => void) | undefined };
    let leg: WebRtcLeg | undefined;
    logger.info("voice call start", { callId, userId: user.id, conversationId: conversation.id, asr: speech.asrEnabled, tts: speech.ttsEnabled });
    const session = new VoiceSession({
      asr: {
        transcribe: async (pcm, rate) => {
          if (!speech.asr) return "";
          try { return await speech.asr.transcribe(pcm, rate); }
          catch (error) { logger.error("voice asr", providerFields(error)); return ""; }
        },
      },
      tts: {
        synthesize: async (text) => {
          if (!speech.tts) return new Int16Array();
          try { return await speech.tts.synthesize(text); }
          catch (error) { logger.error("voice tts", providerFields(error)); return new Int16Array(); }
        },
      },
      reply: async (text) => {
        turns.inc();
        const result = await runTurn({ store, host: await hostFor(user.id), llm, conversationId: conversation.id, text, systemExtra: SPOKEN_HINT });
        return stripMarkdown(result.text);
      },
      onOutbound: (pcm) => {
        stats.outbound += pcm.length;
        leg?.sendPcm(pcm);
      },
      onEvent: (event) => {
        if (event.type === "transcript") logger.info("voice utterance", { callId, speechMs: event.speechMs, asrMs: event.asrMs });
        else if (event.type === "reply") logger.info("voice reply", { callId, llmMs: event.llmMs });
        else if (event.type === "audio") logger.info("voice audio", { callId, ttsMs: event.ttsMs, samples: event.samples });
        else if (event.type === "barge-in") logger.info("voice barge-in", { callId });
        else logger.info("voice skip", { callId, reason: event.reason });
      },
      frameMs: 20,
    });
    stats.stop = () => session.stop();
    try {
      leg = await answerUserVoice(sdp, (pcm) => {
        stats.inbound += pcm.length;
        session.pushInbound(pcm);
      }, {
        iceServers: config.iceServers,
        ...(config.icePortMin && config.icePortMax ? { icePortMin: config.icePortMin, icePortMax: config.icePortMax } : {}),
        ...(config.icePublicIp ? { publicIp: config.icePublicIp } : {}),
        onState: (state) => logger.info("voice state", { callId, ...state, inbound: stats.inbound, outbound: stats.outbound }),
      });
    } catch (error) {
      logger.error("voice call failed", { callId, error: error instanceof Error ? error.message : "webrtc_failed" });
      res.status(400).json({ error: error instanceof Error ? error.message : "webrtc_failed" });
      return;
    }
    if (!leg) return res.status(400).json({ error: "webrtc_failed" });
    stats.leg = leg;
    voiceCalls.set(callId, stats);
    res.json({ id: callId, sdp: leg.answerSdp });
  });
  router.add("GET", "/api/voice/calls/:id", async (req, res) => {
    const user = await userFrom(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const call = voiceCalls.get(req.params.id ?? "");
    if (!call) return res.status(404).json({ error: "not_found" });
    res.json({ inbound: call.inbound, outbound: call.outbound });
  });
  router.add("DELETE", "/api/voice/calls/:id", async (req, res) => {
    const user = await userFrom(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const call = voiceCalls.get(req.params.id ?? "");
    call?.stop?.();
    if (call?.leg) await call.leg.close();
    voiceCalls.delete(req.params.id ?? "");
    logger.info("voice call end", { callId: req.params.id, inbound: call?.inbound ?? 0, outbound: call?.outbound ?? 0 });
    res.json({ ok: true });
  });
  router.add("GET", "/", async (_req, res) => {
    res.text(await readFile(path.join(process.cwd(), "packages/web/public/index.html"), "utf8"), "text/html; charset=utf-8");
  });
  router.add("GET", "/app.js", async (_req, res) => {
    res.text(await readFile(path.join(process.cwd(), "packages/web/public/app.js"), "utf8"), "text/javascript; charset=utf-8");
  });
  router.add("GET", "/app.css", async (_req, res) => {
    res.text(await readFile(path.join(process.cwd(), "packages/web/public/app.css"), "utf8"), "text/css; charset=utf-8");
  });

  const port = config.roles.has("gateway") ? config.gatewayPort : config.roles.has("agent") ? config.agentPort : config.sentinelPort;
  const bound = await listen(router, config.gatewayHost, port);
  let timer: NodeJS.Timeout | undefined;
  if (config.roles.has("sentinel") && env.HEARTH_SENTINEL_EXTERNAL !== "1") {
    const tick = () => {
      sentinelTick({ config, store, mailbox, ownerId: owner.id, wake }).catch((error: unknown) => {
        logger.error("sentinel tick", { error: error instanceof Error ? error.message : "failed" });
      });
    };
    timer = setInterval(tick, config.sentinel.pollMs);
    if (env.HEARTH_SENTINEL_TICK_ON_START === "1") tick();
  }
  logger.info("listening", { url: `http://${config.gatewayHost}:${bound.port}`, dsh });
  return {
    url: `http://127.0.0.1:${bound.port}`,
    port: bound.port,
    config,
    store,
    close: async () => {
      if (timer) clearInterval(timer);
      await new Promise<void>((resolve) => bound.server.close(() => resolve()));
      await ua?.stop();
      for (const call of voiceCalls.values()) await call.leg?.close();
      await store.close();
    },
  };

  async function userFrom(req: { headers: { cookie?: string; authorization?: string } }): Promise<{ id: string; username: string; role: "owner" | "member"; plan: "personal" | "enterprise" } | null> {
    const token = sessionToken(req);
    if (!token) return null;
    const session = await store.findAuthSession(hashToken(token));
    if (!session || Date.parse(session.expiresAt) < Date.now()) return null;
    const user = await store.findUserById(session.userId);
    return user ? { id: user.id, username: user.username, role: user.role, plan: user.plan } : null;
  }
}

function sessionToken(req: { headers: { cookie?: string; authorization?: string } }): string | undefined {
  const header = req.headers.authorization;
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7);
  const cookie = req.headers.cookie ?? "";
  const match = cookie.match(/(?:^|;\s*)hearth_session=([^;]+)/);
  return match?.[1];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function callbackAllowed(presented: string | null, expected?: string): boolean {
  if (!expected) return true;
  return Boolean(presented && safeEqual(presented, expected));
}

async function ensureAdmin(store: Store, config: AppConfig) {
  const existing = await store.findUserByUsername(config.adminUser);
  if (existing) return existing;
  const password = config.adminPassword ?? (config.env === "production" ? "" : "hearth-dev");
  if (!password) throw new Error("HEARTH_ADMIN_PASSWORD is required in production");
  return store.createUser({ username: config.adminUser, passwordHash: await hashPassword(password), role: "owner", plan: config.plan });
}

async function buildMailbox(config: AppConfig, env: NodeJS.ProcessEnv): Promise<Mailbox | undefined> {
  if (env.HEARTH_EMAIL === "memory") return new MemoryMailbox();
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

function buildSms(config: AppConfig, env: NodeJS.ProcessEnv): SmsChannel | undefined {
  if (config.sms.provider === "memory" || env.HEARTH_SMS === "memory") return new MemorySmsChannel(env.HEARTH_SMS_TEMPLATE_ONLY === "1");
  if (config.sms.provider === "aliyun" && config.sms.aliyun.accessKeyId && config.sms.aliyun.accessKeySecret && config.sms.aliyun.signName) {
    return new AliyunSmsChannel({ accessKeyId: config.sms.aliyun.accessKeyId, accessKeySecret: config.sms.aliyun.accessKeySecret, signName: config.sms.aliyun.signName, endpoint: config.sms.aliyun.endpoint, mnsEndpoint: config.sms.aliyun.mnsEndpoint });
  }
  if (config.sms.provider === "twilio" && config.sms.twilio.accountSid && config.sms.twilio.authToken && config.sms.twilio.from) {
    return new TwilioSmsChannel({ accountSid: config.sms.twilio.accountSid, authToken: config.sms.twilio.authToken, from: config.sms.twilio.from });
  }
  if (config.sms.provider === "android-gateway" && config.sms.android.url && config.sms.android.token) {
    return new AndroidSmsGatewayChannel({ url: config.sms.android.url, token: config.sms.android.token });
  }
  return undefined;
}

function buildLlm(config: AppConfig): LlmClient {
  if (config.llm.mode === "mock" || !config.llm.apiKey) return new MockLlm();
  return new DeepSeekMessages({ apiKey: config.llm.apiKey, baseUrl: config.llm.baseUrl, model: config.llm.model, thinking: config.llm.thinking, maxTokens: config.llm.maxTokens });
}

function providerFields(error: unknown): { status?: number; error: string } {
  if (error instanceof SpeechProviderError) return { status: error.status, error: error.message };
  return { error: error instanceof Error ? error.message : "failed" };
}


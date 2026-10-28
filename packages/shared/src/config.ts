export type LogLevel = "debug" | "info" | "warn" | "error";

export type LlmConfig = {
  provider: "deepseek" | "openai-compatible";
  mode: "live" | "mock";
  apiKey?: string;
  baseUrl: string;
  model: string;
  thinking: "enabled" | "disabled";
  maxTokens: number;
};

export type EmailConfig = {
  enabled: boolean;
  requireApproval: boolean;
  host?: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from?: string;
  smtpHost?: string;
  smtpPort: number;
  smtpSecure: boolean;
  mailbox: string;
  gmailClientId?: string;
  gmailClientSecret?: string;
  gmailRefreshToken?: string;
};

export type SmsProviderName = "none" | "memory" | "aliyun" | "twilio" | "android-gateway";

export type SmsConfig = {
  provider: SmsProviderName;
  requireApproval: boolean;
  templates: Record<string, string>;
  aliyun: {
    accessKeyId?: string;
    accessKeySecret?: string;
    signName?: string;
    endpoint: string;
    mnsEnabled: boolean;
    upQueue?: string;
    reportQueue?: string;
    /** Official Dybase demo pins this communications MNS host. Override if Aliyun changes it. */
    mnsEndpoint: string;
    callbackToken?: string;
  };
  twilio: {
    accountSid?: string;
    authToken?: string;
    from?: string;
  };
  android: {
    url?: string;
    token?: string;
  };
};

export type AppConfig = {
  env: string;
  logLevel: LogLevel;
  roles: Set<"gateway" | "agent" | "sentinel" | "telephony">;
  dataDir: string;
  databaseUrl?: string;
  publicUrl: string;
  gatewayHost: string;
  gatewayPort: number;
  agentHost: string;
  agentPort: number;
  sentinelHost: string;
  sentinelPort: number;
  agentUrl: string;
  gatewayInternalUrl: string;
  internalToken: string;
  adminUser: string;
  adminPassword?: string;
  cookieSecure: boolean;
  sessionTtlHours: number;
  llm: LlmConfig;
  spine: "native" | "dsh";
  dshHome: string;
  dshProfile: string;
  email: EmailConfig;
  sms: SmsConfig;
  sandbox: {
    backend: "local" | "docker";
    nodeId: string;
    workspaceRoot: string;
    dockerImage: string;
    advertiseUrl: string;
    url?: string;
  };
  sentinel: { pollMs: number };
  webAllowPrivate: boolean;
  otlpEndpoint?: string;
  telephonyUrl?: string;
  trunkConcurrency: number;
  userCallConcurrency: number;
  userCallRatePerHour: number;
  iceServers: IceServer[];
  icePortMin?: number;
  icePortMax?: number;
  icePublicIp?: string;
  plan: "personal" | "enterprise";
};

export type IceServer = { urls: string | string[]; username?: string; credential?: string };

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  return value === "1" || value === "true" || value === "yes";
}

function num(value: string | undefined, fallback: number): number {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rolesOf(value: string | undefined): AppConfig["roles"] {
  const raw = (value ?? "all").split(",").map((item) => item.trim()).filter(Boolean);
  if (raw.includes("all")) return new Set(["gateway", "agent", "sentinel", "telephony"]);
  const roles = new Set<"gateway" | "agent" | "sentinel" | "telephony">();
  for (const role of raw) {
    if (role === "gateway" || role === "agent" || role === "sentinel" || role === "telephony") roles.add(role);
  }
  if (roles.size === 0) roles.add("gateway");
  return roles;
}

export function iceServersFromEnv(env: NodeJS.ProcessEnv): IceServer[] {
  const servers: IceServer[] = [];
  if (env.HEARTH_ICE_SERVERS) {
    try {
      const parsed = JSON.parse(env.HEARTH_ICE_SERVERS) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== "object") continue;
          const record = item as { urls?: unknown; username?: unknown; credential?: unknown };
          if (typeof record.urls !== "string" && !Array.isArray(record.urls)) continue;
          const server: IceServer = { urls: record.urls as string | string[] };
          if (typeof record.username === "string") server.username = record.username;
          if (typeof record.credential === "string") server.credential = record.credential;
          servers.push(server);
        }
      }
    } catch {
      servers.length = 0;
    }
  }
  if (servers.length === 0 && env.HEARTH_STUN_URL !== "") {
    servers.push({ urls: env.HEARTH_STUN_URL ?? "stun:stun.l.google.com:19302" });
  }
  if (env.HEARTH_TURN_URL) {
    const turn: IceServer = { urls: env.HEARTH_TURN_URL };
    if (env.HEARTH_TURN_USERNAME) turn.username = env.HEARTH_TURN_USERNAME;
    if (env.HEARTH_TURN_PASSWORD) turn.credential = env.HEARTH_TURN_PASSWORD;
    servers.push(turn);
  }
  return servers;
}

function icePorts(env: NodeJS.ProcessEnv): { icePortMin?: number; icePortMax?: number } {
  if (!env.HEARTH_ICE_PORT_MIN || !env.HEARTH_ICE_PORT_MAX) return {};
  const icePortMin = num(env.HEARTH_ICE_PORT_MIN, 0);
  const icePortMax = num(env.HEARTH_ICE_PORT_MAX, 0);
  if (icePortMin <= 0 || icePortMax < icePortMin) return {};
  return { icePortMin, icePortMax };
}

function templates(value: string | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(parsed)) {
      if (typeof item === "string") out[key] = item;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const gatewayPort = num(env.HEARTH_GATEWAY_PORT, 8787);
  const agentPort = num(env.HEARTH_AGENT_PORT, 8788);
  const sentinelPort = num(env.HEARTH_SENTINEL_PORT, 8789);
  const gatewayHost = env.HEARTH_GATEWAY_HOST ?? "127.0.0.1";
  const agentHost = env.HEARTH_AGENT_HOST ?? "127.0.0.1";
  const key = env.DEEPSEEK_API_KEY?.trim() || undefined;
  const mode = env.HEARTH_LLM_MODE === "mock" || env.HEARTH_LLM_MODE === "live"
    ? env.HEARTH_LLM_MODE
    : key ? "live" : "mock";
  const provider = env.LLM_PROVIDER === "openai-compatible" ? "openai-compatible" : "deepseek";
  const smsProvider = (env.SMS_PROVIDER ?? "none") as SmsProviderName;
  return {
    env: env.HEARTH_ENV ?? env.NODE_ENV ?? "development",
    logLevel: (env.HEARTH_LOG_LEVEL as LogLevel) ?? "info",
    roles: rolesOf(env.HEARTH_ROLES),
    dataDir: env.HEARTH_DATA_DIR ?? "./data",
    databaseUrl: env.DATABASE_URL || undefined,
    publicUrl: env.HEARTH_PUBLIC_URL ?? `http://${gatewayHost}:${gatewayPort}`,
    gatewayHost,
    gatewayPort,
    agentHost,
    agentPort,
    sentinelHost: env.HEARTH_SENTINEL_HOST ?? "127.0.0.1",
    sentinelPort,
    agentUrl: env.HEARTH_AGENT_URL ?? `http://${agentHost}:${agentPort}`,
    gatewayInternalUrl: env.HEARTH_INTERNAL_URL ?? `http://${gatewayHost}:${gatewayPort}`,
    internalToken: env.HEARTH_INTERNAL_TOKEN ?? "dev-internal-token",
    adminUser: env.HEARTH_ADMIN_USER ?? "owner",
    adminPassword: env.HEARTH_ADMIN_PASSWORD || undefined,
    cookieSecure: bool(env.HEARTH_COOKIE_SECURE, false),
    sessionTtlHours: num(env.HEARTH_SESSION_TTL_HOURS, 168),
    llm: {
      provider,
      mode,
      apiKey: key,
      baseUrl: env.DEEPSEEK_BASE_URL ?? (provider === "deepseek"
        ? "https://api.deepseek.com/anthropic"
        : env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"),
      model: env.DEEPSEEK_MODEL ?? "deepseek-flash",
      thinking: env.DEEPSEEK_THINKING === "enabled" ? "enabled" : "disabled",
      maxTokens: num(env.DEEPSEEK_MAX_TOKENS, 1024),
    },
    spine: env.HEARTH_SPINE === "dsh" ? "dsh" : "native",
    dshHome: env.DSH_HOME ?? "./data/dsh",
    dshProfile: env.DSH_PROFILE ?? "hearth",
    email: {
      enabled: bool(env.EMAIL_ENABLED, Boolean(env.IMAP_HOST && env.IMAP_USER)),
      requireApproval: bool(env.EMAIL_REQUIRE_APPROVAL, true),
      host: env.IMAP_HOST,
      port: num(env.IMAP_PORT, 993),
      secure: bool(env.IMAP_SECURE, true),
      user: env.IMAP_USER,
      password: env.IMAP_PASSWORD,
      from: env.SMTP_FROM ?? env.IMAP_USER,
      smtpHost: env.SMTP_HOST ?? env.IMAP_HOST,
      smtpPort: num(env.SMTP_PORT, 465),
      smtpSecure: bool(env.SMTP_SECURE, true),
      mailbox: env.IMAP_MAILBOX ?? "INBOX",
      gmailClientId: env.GMAIL_CLIENT_ID,
      gmailClientSecret: env.GMAIL_CLIENT_SECRET,
      gmailRefreshToken: env.GMAIL_REFRESH_TOKEN,
    },
    sms: {
      provider: smsProvider,
      requireApproval: bool(env.SMS_REQUIRE_APPROVAL, true),
      templates: templates(env.SMS_TEMPLATE_MAP),
      aliyun: {
        accessKeyId: env.ALIBABA_CLOUD_ACCESS_KEY_ID ?? env.ALIYUN_SMS_ACCESS_KEY_ID,
        accessKeySecret: env.ALIBABA_CLOUD_ACCESS_KEY_SECRET ?? env.ALIYUN_SMS_ACCESS_KEY_SECRET,
        signName: env.ALIYUN_SMS_SIGN_NAME,
        endpoint: env.ALIYUN_SMS_ENDPOINT ?? "dysmsapi.aliyuncs.com",
        mnsEnabled: bool(env.ALIYUN_SMS_MNS, false),
        upQueue: env.ALIYUN_SMS_UP_QUEUE,
        reportQueue: env.ALIYUN_SMS_REPORT_QUEUE,
        mnsEndpoint: env.ALIYUN_SMS_MNS_ENDPOINT ?? "https://1943695596114318.mns.cn-hangzhou.aliyuncs.com",
        callbackToken: env.ALIYUN_SMS_CALLBACK_TOKEN,
      },
      twilio: {
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
        from: env.TWILIO_FROM,
      },
      android: {
        url: env.ANDROID_SMS_GATEWAY_URL,
        token: env.ANDROID_SMS_GATEWAY_TOKEN,
      },
    },
    sandbox: {
      backend: (() => {
        const production = (env.HEARTH_ENV ?? env.NODE_ENV) === "production";
        if (env.HEARTH_SANDBOX === "docker" || env.HEARTH_SANDBOX === "local") return env.HEARTH_SANDBOX;
        return production ? "docker" : "local";
      })(),
      nodeId: env.HEARTH_NODE_ID ?? "local",
      workspaceRoot: env.HEARTH_WORKSPACE_ROOT ?? "./data/workspaces",
      dockerImage: env.HEARTH_SANDBOX_IMAGE ?? "hearth-sandbox:local",
      advertiseUrl: env.HEARTH_NODE_ADVERTISE_URL ?? `http://${agentHost}:${agentPort}`,
      url: env.HEARTH_SANDBOX_URL || undefined,
    },
    sentinel: { pollMs: num(env.HEARTH_SENTINEL_POLL_MS, 15000) },
    webAllowPrivate: bool(env.WEB_ALLOW_PRIVATE, false),
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
    telephonyUrl: env.HEARTH_TELEPHONY_URL || undefined,
    trunkConcurrency: num(env.SIP_TRUNK_CONCURRENCY, 2),
    userCallConcurrency: num(env.SIP_USER_CONCURRENCY, 1),
    userCallRatePerHour: num(env.SIP_USER_RATE_PER_HOUR, 20),
    iceServers: iceServersFromEnv(env),
    ...icePorts(env),
    ...(env.HEARTH_ICE_PUBLIC_IP?.trim() ? { icePublicIp: env.HEARTH_ICE_PUBLIC_IP.trim() } : {}),
    plan: env.HEARTH_PLAN === "enterprise" ? "enterprise" : "personal",
  };
}

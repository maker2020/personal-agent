export type TrunkMode = "register" | "ip";
export type Codec = "PCMA" | "PCMU";

export type SipConfig = {
  profile: string;
  mode: TrunkMode;
  proxyHost: string;
  proxyPort: number;
  domain: string;
  username?: string;
  password?: string;
  callerId: string;
  calledPrefix: string;
  publicIp: string;
  signalHost: string;
  signalPort: number;
  rtpPortMin: number;
  rtpPortMax: number;
  codecs: Codec[];
  registerExpires: number;
  autoAnswer: boolean;
  requireApproval: boolean;
};

export const ALIYUN_REGIONS = {
  shanghai: { proxyHost: "sh.siptrunk.aliyun.com", proxyPort: 5060 },
  beijing: { proxyHost: "bj.siptrunk.aliyun.com", proxyPort: 5060 },
  shenzhen: { proxyHost: "sz.siptrunk.aliyun.com", proxyPort: 5060 },
} as const;

export type AliyunRegion = keyof typeof ALIYUN_REGIONS;

/**
 * Aliyun VMS production trunks are IP-peered (no username/password).
 * A trial line may instead be a digest registration account issued for the test.
 * Switching trial → production is SIP_PROFILE plus the issued values, not a code change.
 */
export function resolveSipConfig(env: NodeJS.ProcessEnv): SipConfig {
  const profile = env.SIP_PROFILE ?? "generic";
  const region = (env.SIP_REGION ?? "shanghai") as AliyunRegion;
  const regional = ALIYUN_REGIONS[region] ?? ALIYUN_REGIONS.shanghai;
  const aliyun = profile === "aliyun-prod" || profile === "aliyun-trial";
  const explicitMode = env.SIP_TRUNK_MODE === "register" || env.SIP_TRUNK_MODE === "ip" ? env.SIP_TRUNK_MODE : undefined;
  const mode: TrunkMode = explicitMode
    ?? (profile === "aliyun-prod" ? "ip" : env.SIP_USERNAME ? "register" : "ip");
  const codecs = (env.SIP_CODECS ?? (aliyun ? "PCMA,PCMU" : "PCMU,PCMA"))
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter((item): item is Codec => item === "PCMA" || item === "PCMU");
  return {
    profile,
    mode,
    proxyHost: env.SIP_PROXY_HOST ?? (aliyun ? regional.proxyHost : "127.0.0.1"),
    proxyPort: number(env.SIP_PROXY_PORT, aliyun ? regional.proxyPort : 5060),
    domain: env.SIP_DOMAIN ?? env.SIP_PROXY_HOST ?? (aliyun ? regional.proxyHost : "127.0.0.1"),
    username: env.SIP_USERNAME,
    password: env.SIP_PASSWORD,
    callerId: env.SIP_CALLER_ID ?? env.SIP_USERNAME ?? "hearth",
    calledPrefix: env.SIP_CALLED_PREFIX ?? "",
    publicIp: env.SIP_PUBLIC_IP ?? "127.0.0.1",
    signalHost: env.SIP_SIGNAL_HOST ?? "0.0.0.0",
    signalPort: number(env.SIP_SIGNAL_PORT, 5060),
    rtpPortMin: number(env.SIP_RTP_PORT_MIN, 10000),
    rtpPortMax: number(env.SIP_RTP_PORT_MAX, 10199),
    codecs: codecs.length ? codecs : ["PCMA"],
    registerExpires: number(env.SIP_REGISTER_EXPIRES, 300),
    autoAnswer: env.SIP_AUTO_ANSWER !== "0",
    requireApproval: env.SIP_REQUIRE_APPROVAL !== "0",
  };
}

export function validateSipConfig(config: SipConfig): string[] {
  const errors: string[] = [];
  if (!config.proxyHost) errors.push("SIP proxy host is required");
  if (config.mode === "register" && (!config.username || !config.password)) {
    errors.push("registration mode requires SIP_USERNAME and SIP_PASSWORD");
  }
  if (config.profile === "aliyun-prod") {
    if (!config.publicIp || config.publicIp === "127.0.0.1") errors.push("aliyun-prod requires SIP_PUBLIC_IP (the cloud server EIP)");
    if (!config.callerId) errors.push("aliyun-prod requires SIP_CALLER_ID");
  }
  if (config.rtpPortMax < config.rtpPortMin) errors.push("RTP port range is inverted");
  return errors;
}

export const ALIYUN_SIP_CODES: Record<number, { id: string; zh: string }> = {
  470: { id: "CONFIG_ERROR", zh: "配置异常。请确认对接 IP 与前缀。" },
  471: { id: "NO_AVAILABLE_LINE", zh: "选路失败或无可用线路。" },
  472: { id: "ILLEGAL_CALLER_NUMBER", zh: "主叫号码非法。" },
  473: { id: "CALLED_FREQUENCY_LIMIT", zh: "被叫超频。" },
  474: { id: "CALLED_BLACKLIST_LIMIT", zh: "被叫在黑名单。" },
  475: { id: "CALL_CAPS_LIMIT", zh: "呼叫频次超限。" },
  476: { id: "ACCOUNT_STOP_LIMIT", zh: "账号欠费或被限制。" },
  477: { id: "CALLER_FREQUENCY_LIMIT", zh: "主叫超频。" },
};

function number(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

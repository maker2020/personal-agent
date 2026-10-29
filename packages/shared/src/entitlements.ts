export type Plan = "personal" | "enterprise";

export type Feature = "voice" | "pstn" | "sms" | "dedicatedDid";

export type Entitlements = {
  plan: Plan;
  voice: true;
  pstn: boolean;
  sms: boolean;
  dedicatedDid: boolean;
};

/**
 * Voice is on for every tenant. PSTN and SMS stay off unless the tenant is on
 * the enterprise plan and the platform flag is enabled. HEARTH_DEV_PSTN and
 * HEARTH_DEV_SMS open the trial path without changing code.
 */
export function entitlements(plan: Plan | undefined, env: NodeJS.ProcessEnv): Entitlements {
  const resolved = plan === "enterprise" ? "enterprise" : "personal";
  const enterprise = resolved === "enterprise";
  const pstn = env.HEARTH_DEV_PSTN === "1" || (enterprise && env.PSTN_ENABLED === "1");
  const sms = env.HEARTH_DEV_SMS === "1" || (enterprise && env.SMS_ENABLED === "1");
  return { plan: resolved, voice: true, pstn, sms, dedicatedDid: enterprise && pstn };
}

import { createHash, randomBytes } from "node:crypto";

function parseDigest(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = value.replace(/^Digest\s+/i, "");
  for (const part of body.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const [key, ...rest] = part.split("=");
    if (!key) continue;
    out[key.trim()] = rest.join("=").trim().replace(/^"|"$/g, "");
  }
  return out;
}

export function digestAuthorization(input: {
  username: string;
  password: string;
  method: string;
  uri: string;
  challenge: string;
}): string {
  const params = parseDigest(input.challenge);
  const realm = params.realm ?? "";
  const nonce = params.nonce ?? "";
  const qop = params.qop?.split(",")[0]?.trim();
  const ha1 = md5(`${input.username}:${realm}:${input.password}`);
  const ha2 = md5(`${input.method}:${input.uri}`);
  let response: string;
  let extra = "";
  if (qop) {
    const nc = "00000001";
    const cnonce = randomBytes(8).toString("hex");
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    extra = `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }
  const opaque = params.opaque ? `, opaque="${params.opaque}"` : "";
  return `Digest username="${input.username}", realm="${realm}", nonce="${nonce}", uri="${input.uri}", response="${response}", algorithm=MD5${extra}${opaque}`;
}

export function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

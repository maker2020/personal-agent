export type SipMessage = {
  start: string;
  method?: string;
  uri?: string;
  status?: number;
  reason?: string;
  headers: Record<string, string>;
  body: string;
};

export function parseSip(raw: string): SipMessage {
  const text = raw.replace(/\r\n/g, "\n");
  const split = text.indexOf("\n\n");
  const head = split >= 0 ? text.slice(0, split) : text;
  const body = split >= 0 ? text.slice(split + 2) : "";
  const lines = head.split("\n").filter((line) => line.length > 0);
  const start = lines[0] ?? "";
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  const request = start.match(/^([A-Z]+)\s+(\S+)\s+SIP\/2\.0$/);
  if (request) return { start, method: request[1], uri: request[2], headers, body };
  const response = start.match(/^SIP\/2\.0\s+(\d+)\s*(.*)$/);
  if (response) return { start, status: Number(response[1]), reason: response[2] ?? "", headers, body };
  throw new Error(`not a SIP message: ${start}`);
}

export function buildSip(input: { start: string; headers: Record<string, string>; body?: string }): string {
  const body = input.body ?? "";
  const headers = { ...input.headers, "Content-Length": String(Buffer.byteLength(body)) };
  const lines = [input.start];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
}

export function headerParams(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of value.split(",")) {
    const bits = part.split(";");
    const scheme = bits[0]?.trim() ?? "";
    const schemeMatch = scheme.match(/^(\w+)\s+(.*)$/);
    if (schemeMatch) out.scheme = schemeMatch[1] ?? "";
    for (const bit of bits.slice(1)) {
      const [key, ...rest] = bit.split("=");
      if (!key) continue;
      out[key.trim()] = (rest.join("=") || "").replace(/^"|"$/g, "");
    }
  }
  return out;
}

export function tagOf(header: string | undefined, which: "from" | "to"): string | undefined {
  if (!header) return undefined;
  const match = header.match(/tag=([^;\s]+)/);
  return match?.[1];
  void which;
}

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export function isPrivateAddress(ip: string): boolean {
  if (!isIP(ip)) return true;
  if (ip.includes(":")) {
    const lower = ip.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map((part) => Number(part));
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export async function assertPublicHttpUrl(raw: string, allowPrivate = false): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http(s) URLs are allowed");
  if (allowPrivate) return url;
  const addresses = isIP(url.hostname) ? [url.hostname] : (await lookup(url.hostname, { all: true })).map((item) => item.address);
  if (addresses.some((address) => isPrivateAddress(address))) throw new Error("refusing private or local address");
  return url;
}

export async function fetchWebText(raw: string, allowPrivate = false): Promise<{ url: string; title: string; text: string }> {
  const url = await assertPublicHttpUrl(raw, allowPrivate);
  const response = await fetch(url, { redirect: "manual", headers: { "user-agent": "Hearth/0.1" } });
  if (response.status >= 300 && response.status < 400) throw new Error("redirects are not followed");
  const html = (await response.text()).slice(0, 200_000);
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? "";
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
  return { url: url.toString(), title, text };
}

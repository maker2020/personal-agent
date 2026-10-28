import { createHash, createHmac } from "node:crypto";

export type MnsCredentials = {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
};

/**
 * Aliyun MNS string-to-sign.
 * https://www.alibabacloud.com/help/en/mns/developer-reference/how-to-use-signature-mechanism
 */
export function mnsStringToSign(input: {
  method: string;
  contentMd5?: string;
  contentType?: string;
  date: string;
  headers: Record<string, string>;
  resource: string;
}): string {
  const canonicalHeaders = Object.entries(input.headers)
    .filter(([key]) => key.toLowerCase().startsWith("x-mns-"))
    .map(([key, value]) => [key.toLowerCase(), value.trim()] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${value}\n`)
    .join("");
  return [
    input.method.toUpperCase(),
    input.contentMd5 ?? "",
    input.contentType ?? "",
    input.date,
    canonicalHeaders + input.resource,
  ].join("\n");
}

export function mnsAuthorization(accessKeyId: string, accessKeySecret: string, stringToSign: string): string {
  const signature = createHmac("sha1", accessKeySecret).update(stringToSign).digest("base64");
  return `MNS ${accessKeyId}:${signature}`;
}

export type MnsMessage = { messageId: string; receiptHandle: string; body: string };

export function parseMnsMessages(xml: string): MnsMessage[] {
  const blocks = xml.split(/<Message>/).slice(1);
  return blocks.map((block) => ({
    messageId: tag(block, "MessageId"),
    receiptHandle: tag(block, "ReceiptHandle"),
    body: decodeXml(tag(block, "MessageBody")),
  })).filter((item) => item.messageId && item.body);
}

function tag(xml: string, name: string): string {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match?.[1]?.trim() ?? "";
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export class MnsQueueClient {
  constructor(private endpoint: string, private credentials: MnsCredentials, private fetchImpl: typeof fetch = fetch) {}

  async receive(queueName: string, waitSeconds = 3, numOfMessages = 10): Promise<MnsMessage[]> {
    const resource = `/queues/${encodeURIComponent(queueName)}/messages?numOfMessages=${numOfMessages}&waitseconds=${waitSeconds}`;
    const xml = await this.request("GET", resource);
    if (!xml) return [];
    return parseMnsMessages(xml);
  }

  async delete(queueName: string, receiptHandle: string): Promise<void> {
    const resource = `/queues/${encodeURIComponent(queueName)}/messages?ReceiptHandle=${encodeURIComponent(receiptHandle)}`;
    await this.request("DELETE", resource);
  }

  private async request(method: string, resource: string): Promise<string> {
    const date = new Date().toUTCString();
    const headers: Record<string, string> = {
      "x-mns-version": "2015-06-06",
      "x-mns-security-token": this.credentials.securityToken,
    };
    const stringToSign = mnsStringToSign({ method, date, headers, resource: resource.split("?")[0] + canonicalQuery(resource) });
    const response = await this.fetchImpl(`${this.endpoint.replace(/\/$/, "")}${resource}`, {
      method,
      headers: {
        ...headers,
        date,
        authorization: mnsAuthorization(this.credentials.accessKeyId, this.credentials.accessKeySecret, stringToSign),
      },
    });
    if (response.status === 404) return "";
    const text = await response.text();
    if (!response.ok) throw new Error(`MNS ${method} failed (${response.status})`);
    return text;
  }
}

function canonicalQuery(resource: string): string {
  const query = resource.split("?")[1];
  if (!query) return "";
  const pairs = query.split("&").filter(Boolean).sort();
  return pairs.length ? `?${pairs.join("&")}` : "";
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

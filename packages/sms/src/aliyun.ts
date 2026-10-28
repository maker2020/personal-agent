import { createRequire } from "node:module";
import type { SmsChannel, SmsSendRequest, SmsSendResult } from "./types.js";
import { SmsPolicyError } from "./types.js";
import { MnsQueueClient, type MnsCredentials } from "./mns.js";

const require = createRequire(import.meta.url);

export type AliyunSmsOptions = {
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;
  endpoint?: string;
  mnsEndpoint?: string;
};

export type AliyunSendApi = {
  sendSms(input: { phoneNumbers: string; signName: string; templateCode: string; templateParam?: string; outId?: string }): Promise<{ code?: string; message?: string; bizId?: string }>;
};

/**
 * Domestic Aliyun SMS is A2P: SendSms accepts an approved SignName + TemplateCode only.
 * Free-form body is rejected here so a model cannot bypass the template.
 * API: Dysmsapi 2017-05-25 SendSms, host dysmsapi.aliyuncs.com.
 */
export class AliyunSmsChannel implements SmsChannel {
  readonly id = "aliyun";
  readonly templateOnly = true;

  constructor(private options: AliyunSmsOptions, private api: AliyunSendApi = createSdkApi(options)) {}

  async send(input: SmsSendRequest): Promise<SmsSendResult> {
    if (!input.templateCode) {
      throw new SmsPolicyError("阿里云国内短信是模板发送：必须提供已审核的 TemplateCode 和签名，不能发送自由文本。");
    }
    if (input.body && !input.templateCode) {
      throw new SmsPolicyError("阿里云短信不接受自由文本正文。");
    }
    const signName = input.signName || this.options.signName;
    if (!signName) throw new SmsPolicyError("缺少短信签名 SignName。");
    const response = await this.api.sendSms({
      phoneNumbers: input.to,
      signName,
      templateCode: input.templateCode,
      templateParam: input.templateParams ? JSON.stringify(input.templateParams) : undefined,
      outId: input.outId,
    });
    if (response.code !== "OK") {
      return { provider: this.id, status: "failed", detail: response.message ?? response.code ?? "SendSms failed", providerId: response.bizId };
    }
    return { provider: this.id, status: "submitted", providerId: response.bizId, detail: response.message };
  }
}

export function createSdkApi(options: AliyunSmsOptions): AliyunSendApi {
  return {
    async sendSms(input) {
      const Dysmsapi = require("@alicloud/dysmsapi20170525") as {
        default: new (config: unknown) => { sendSms: (request: unknown) => Promise<{ body?: { code?: string; message?: string; bizId?: string } }> };
        SendSmsRequest: new (map: Record<string, unknown>) => unknown;
      };
      const openapi = require("@alicloud/openapi-core") as { $OpenApiUtil: { Config: new (map: Record<string, unknown>) => unknown } };
      const client = new Dysmsapi.default(new openapi.$OpenApiUtil.Config({
        accessKeyId: options.accessKeyId,
        accessKeySecret: options.accessKeySecret,
        endpoint: options.endpoint ?? "dysmsapi.aliyuncs.com",
      }));
      const response = await client.sendSms(new Dysmsapi.SendSmsRequest({
        phoneNumbers: input.phoneNumbers,
        signName: input.signName,
        templateCode: input.templateCode,
        templateParam: input.templateParam,
        outId: input.outId,
      }));
      return {
        code: response.body?.code,
        message: response.body?.message,
        bizId: response.body?.bizId,
      };
    },
  };
}

export async function queryMnsToken(options: AliyunSmsOptions, messageType: string, queueName: string): Promise<MnsCredentials> {
  const Dybase = require("@alicloud/dybaseapi20170525") as {
    default: new (config: unknown) => { queryTokenForMnsQueue: (request: unknown) => Promise<{ body?: { code?: string; messageTokenDTO?: { accessKeyId?: string; accessKeySecret?: string; securityToken?: string } } }> };
    QueryTokenForMnsQueueRequest: new (map: Record<string, unknown>) => unknown;
  };
  const OpenApi = require("@alicloud/openapi-client") as { Config: new (map: Record<string, unknown>) => unknown };
  const client = new Dybase.default(new OpenApi.Config({
    accessKeyId: options.accessKeyId,
    accessKeySecret: options.accessKeySecret,
    endpoint: "dybaseapi.aliyuncs.com",
  }));
  const response = await client.queryTokenForMnsQueue(new Dybase.QueryTokenForMnsQueueRequest({
    messageType,
    queueName,
  }));
  const token = response.body?.messageTokenDTO;
  if (response.body?.code !== "OK" || !token?.accessKeyId || !token.accessKeySecret || !token.securityToken) {
    throw new Error("QueryTokenForMnsQueue failed");
  }
  return { accessKeyId: token.accessKeyId, accessKeySecret: token.accessKeySecret, securityToken: token.securityToken };
}

export async function pullAliyunQueue(options: AliyunSmsOptions, messageType: "SmsUp" | "SmsReport", queueName: string): Promise<string[]> {
  const credentials = await queryMnsToken(options, messageType, queueName);
  const endpoint = options.mnsEndpoint ?? "https://1943695596114318.mns.cn-hangzhou.aliyuncs.com";
  const client = new MnsQueueClient(endpoint, credentials);
  const messages = await client.receive(queueName);
  const bodies: string[] = [];
  for (const message of messages) {
    bodies.push(message.body);
    await client.delete(queueName, message.receiptHandle);
  }
  return bodies;
}

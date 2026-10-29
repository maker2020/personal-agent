import type { SmsChannel, SmsSendRequest, SmsSendResult } from "./types.js";

export class MemorySmsChannel implements SmsChannel {
  readonly id = "memory";
  readonly templateOnly: boolean;
  sent: SmsSendRequest[] = [];
  constructor(templateOnly = false) {
    this.templateOnly = templateOnly;
  }
  async send(input: SmsSendRequest): Promise<SmsSendResult> {
    this.sent.push(input);
    return { provider: this.id, status: "sent", providerId: `mem-${this.sent.length}` };
  }
}

export type { SmsChannel, SmsSendRequest, SmsSendResult, InboundSms, SmsReceipt } from "./types.js";
export { SmsPolicyError } from "./types.js";
export { parseAliyunSmsUp, parseAliyunSmsReport, ALIYUN_SMS_HTTP_ACK } from "./aliyun-callback.js";
export { AliyunSmsChannel, pullAliyunQueue, type AliyunSmsOptions } from "./aliyun.js";
export { TwilioSmsChannel, parseTwilioInbound, verifyTwilioSignature } from "./twilio.js";
export { AndroidSmsGatewayChannel, parseAndroidInbound } from "./android.js";
export { MnsQueueClient, mnsStringToSign, mnsAuthorization, parseMnsMessages } from "./mns.js";

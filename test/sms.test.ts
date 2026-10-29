import assert from "node:assert/strict";
import test from "node:test";
import { AliyunSmsChannel } from "../packages/sms/src/aliyun.js";
import { parseAliyunSmsReport, parseAliyunSmsUp, ALIYUN_SMS_HTTP_ACK } from "../packages/sms/src/aliyun-callback.js";
import { SmsPolicyError } from "../packages/sms/src/types.js";
import { mnsStringToSign } from "../packages/sms/src/mns.js";

test("aliyun sms rejects free-form text", async () => {
  const channel = new AliyunSmsChannel({ accessKeyId: "x", accessKeySecret: "y", signName: "测试" }, {
    async sendSms() { throw new Error("should not send"); },
  });
  await assert.rejects(() => channel.send({ to: "13800000000", body: "你好" }), SmsPolicyError);
});

test("aliyun sms sends template fields only", async () => {
  let seen: Record<string, unknown> | undefined;
  const channel = new AliyunSmsChannel({ accessKeyId: "x", accessKeySecret: "y", signName: "测试签名" }, {
    async sendSms(input) { seen = input; return { code: "OK", message: "OK", bizId: "biz-1" }; },
  });
  const result = await channel.send({ to: "13800000000", templateCode: "SMS_1", templateParams: { code: "1234" } });
  assert.equal(result.status, "submitted");
  assert.equal(result.providerId, "biz-1");
  assert.equal(seen?.signName, "测试签名");
  assert.equal(seen?.templateCode, "SMS_1");
  assert.equal(seen?.templateParam, "{\"code\":\"1234\"}");
});

test("smsup and smsreport parsers keep idempotency keys", () => {
  const up = parseAliyunSmsUp([{ phone_number: "13800000000", content: "收到", send_time: "2026-10-28 10:00:00", dest_code: "1", sequence_id: "99" }]);
  assert.equal(up[0]?.dedupeKey, "aliyun:up:99");
  const report = parseAliyunSmsReport([{ phone_number: "13800000000", success: true, err_code: "DELIVERED", biz_id: "biz", report_time: "2026-10-28 10:00:01", sms_size: "1", send_time: "2026-10-28 10:00:00", err_msg: "用户接收成功", out_id: "a" }]);
  assert.equal(report[0]?.success, true);
  assert.equal(ALIYUN_SMS_HTTP_ACK.code, 0);
});

test("mns string to sign includes security token header", () => {
  const signed = mnsStringToSign({
    method: "GET",
    date: "Wed, 28 Oct 2026 00:00:00 GMT",
    headers: { "x-mns-version": "2015-06-06", "x-mns-security-token": "tok" },
    resource: "/queues/Alicom-Queue-demo-SmsUp/messages",
  });
  assert.match(signed, /x-mns-security-token:tok\n/);
  assert.match(signed, /x-mns-version:2015-06-06\n/);
});

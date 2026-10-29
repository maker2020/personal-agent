import dgram from "node:dgram";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { payloadToPcm, pcmToPayload } from "./g711.js";
import { digestAuthorization } from "./digest.js";
import { buildSip, parseSip, type SipMessage } from "./sip-message.js";
import { ALIYUN_SIP_CODES, type Codec, type SipConfig } from "./preset.js";

export type CallState = "proceeding" | "ringing" | "confirmed" | "ended";

type Dialog = {
  callId: string;
  localTag: string;
  remoteTag?: string;
  remoteTarget: string;
  cseq: number;
  direction: "in" | "out";
  state: CallState;
  rtp?: dgram.Socket;
  rtpPort?: number;
  remoteRtp?: { host: string; port: number };
  codec: Codec;
  peer: string;
};

export class SipUserAgent extends EventEmitter {
  private socket?: dgram.Socket;
  private dialogs = new Map<string, Dialog>();
  private cseq = 1;
  private nextRtp: number;

  constructor(private config: SipConfig) {
    super();
    this.nextRtp = config.rtpPortMin;
  }

  async start(): Promise<number> {
    const socket = dgram.createSocket("udp4");
    this.socket = socket;
    socket.on("message", (msg, rinfo) => {
      this.onDatagram(msg.toString("utf8"), rinfo.address, rinfo.port);
    });
    await new Promise<void>((resolve) => socket.bind(this.config.signalPort, this.config.signalHost, () => resolve()));
    const address = socket.address();
    return typeof address === "object" ? address.port : this.config.signalPort;
  }

  async stop(): Promise<void> {
    for (const dialog of this.dialogs.values()) dialog.rtp?.close();
    this.dialogs.clear();
    await new Promise<void>((resolve) => this.socket?.close(() => resolve()));
  }

  localPort(): number {
    const address = this.socket?.address();
    return typeof address === "object" ? address.port : this.config.signalPort;
  }

  async register(): Promise<void> {
    if (this.config.mode !== "register") return;
    const uri = `sip:${this.config.domain}`;
    await this.request("REGISTER", uri, {
      expires: String(this.config.registerExpires),
      contact: this.contact(),
    });
    this.emit("registered");
  }

  async invite(to: string): Promise<Dialog> {
    const user = `${this.config.calledPrefix}${to}`;
    const uri = `sip:${user}@${this.config.domain}`;
    const dialog = this.newDialog("out", uri, to);
    const body = this.sdp(dialog);
    await this.request("INVITE", uri, { contact: this.contact(), contentType: "application/sdp" }, body, dialog);
    return dialog;
  }

  async hangup(callId: string): Promise<void> {
    const dialog = this.dialogs.get(callId);
    if (!dialog || dialog.state === "ended") return;
    dialog.cseq += 1;
    const uri = dialog.remoteTarget;
    this.send(this.requestMessage("BYE", uri, dialog));
    dialog.state = "ended";
    dialog.rtp?.close();
  }

  sendPcm(callId: string, pcm: Int16Array): void {
    const dialog = this.dialogs.get(callId);
    if (!dialog?.rtp || !dialog.remoteRtp) return;
    const payload = pcmToPayload(pcm, dialog.codec);
    const packet = Buffer.alloc(12 + payload.length);
    packet[0] = 0x80;
    packet[1] = dialog.codec === "PCMA" ? 8 : 0;
    packet.writeUInt16BE(Math.floor(Math.random() * 65535), 2);
    packet.writeUInt32BE(Date.now() & 0xffffffff, 4);
    packet.writeUInt32BE(0x68656172, 8);
    payload.copy(packet, 12);
    dialog.rtp.send(packet, dialog.remoteRtp.port, dialog.remoteRtp.host);
  }

  private async request(method: string, uri: string, extra: Record<string, string>, body = "", dialog?: Dialog): Promise<void> {
    const message = this.requestMessage(method, uri, dialog, extra, body);
    const response = await this.sendAndWait(message, (parsed) => {
      const cseq = parsed.headers.cseq ?? "";
      return cseq.startsWith(String(dialog?.cseq ?? this.cseq)) && cseq.includes(method);
    });
    if (response.status === 401 || response.status === 407) {
      const challenge = response.headers["www-authenticate"] ?? response.headers["proxy-authenticate"] ?? "";
      const authorization = digestAuthorization({
        username: this.config.username ?? "",
        password: this.config.password ?? "",
        method,
        uri,
        challenge,
      });
      const authed = this.requestMessage(method, uri, dialog, { ...extra, authorization }, body);
      const next = await this.sendAndWait(authed, (parsed) => (parsed.headers.cseq ?? "").includes(method));
      this.acceptResponse(method, next, dialog);
      return;
    }
    this.acceptResponse(method, response, dialog);
  }

  private acceptResponse(method: string, response: SipMessage, dialog?: Dialog): void {
    if ((response.status ?? 0) >= 300) {
      const known = response.status ? ALIYUN_SIP_CODES[response.status] : undefined;
      throw new Error(known ? `${known.id}: ${known.zh}` : `SIP ${method} failed (${response.status})`);
    }
    if (method === "INVITE" && response.status === 200 && dialog) {
      this.applyRemote(dialog, response);
      dialog.state = "confirmed";
      this.send(this.requestMessage("ACK", dialog.remoteTarget, dialog, {}, "", true));
      this.emit("answered", { callId: dialog.callId, peer: dialog.peer });
    }
  }

  private requestMessage(method: string, uri: string, dialog?: Dialog, extra: Record<string, string> = {}, body = "", ack = false): string {
    const cseq = ack ? dialog?.cseq ?? this.cseq : (dialog ? dialog.cseq : ++this.cseq);
    if (dialog && !ack && method !== "ACK") dialog.cseq = cseq;
    const fromTag = dialog?.localTag ?? randomBytes(4).toString("hex");
    const toTag = dialog?.remoteTag ? `;tag=${dialog.remoteTag}` : "";
    const headers: Record<string, string> = {
      Via: `SIP/2.0/UDP ${this.config.publicIp}:${this.localPort()};rport;branch=z9hG4bK${randomBytes(6).toString("hex")}`,
      From: `<sip:${this.config.callerId}@${this.config.domain}>;tag=${fromTag}`,
      To: `<sip:${dialog?.peer ?? this.config.callerId}@${this.config.domain}>${toTag}`,
      "Call-ID": dialog?.callId ?? `${randomBytes(8).toString("hex")}@${this.config.publicIp}`,
      CSeq: `${cseq} ${method}`,
      "Max-Forwards": "70",
      Contact: extra.contact ?? this.contact(),
      "User-Agent": "Hearth/0.1",
    };
    if (extra.expires) headers.Expires = extra.expires;
    if (extra.authorization) headers.Authorization = extra.authorization;
    if (extra.contentType) headers["Content-Type"] = extra.contentType;
    return buildSip({ start: `${method} ${uri} SIP/2.0`, headers, body });
  }

  private onDatagram(raw: string, host: string, port: number): void {
    let message: SipMessage;
    try {
      message = parseSip(raw);
    } catch {
      return;
    }
    if (message.method === "OPTIONS") {
      this.reply(message, 200, "OK");
      return;
    }
    if (message.method === "INVITE") {
      void this.onInvite(message);
      return;
    }
    if (message.method === "ACK") return;
    if (message.method === "BYE") {
      const callId = message.headers["call-id"] ?? "";
      const dialog = this.dialogs.get(callId);
      if (dialog) {
        dialog.state = "ended";
        dialog.rtp?.close();
        this.emit("ended", { callId });
      }
      this.reply(message, 200, "OK");
      return;
    }
    if (message.status) {
      this.emit("response", message, host, port);
    }
  }

  private async onInvite(message: SipMessage): Promise<void> {
    this.reply(message, 100, "Trying");
    const callId = message.headers["call-id"] ?? randomBytes(6).toString("hex");
    const dialog = this.newDialog("in", message.uri ?? "", userOf(message.headers.from ?? ""), callId);
    const fromTag = message.headers.from?.match(/tag=([^;\s]+)/)?.[1];
    if (fromTag) dialog.remoteTag = fromTag;
    dialog.localTag = message.headers.to?.match(/tag=([^;\s]+)/)?.[1] ?? dialog.localTag;
    this.applyRemote(dialog, message);
    this.emit("incoming", { callId: dialog.callId, peer: dialog.peer });
    if (this.config.autoAnswer) {
      this.reply(message, 200, "OK", this.sdp(dialog), dialog.localTag);
      dialog.state = "confirmed";
      this.emit("answered", { callId: dialog.callId, peer: dialog.peer });
    } else {
      this.reply(message, 180, "Ringing");
      dialog.state = "ringing";
    }
  }

  private applyRemote(dialog: Dialog, message: SipMessage): void {
    const audio = parseSdp(message.body);
    if (audio) dialog.remoteRtp = audio;
    const contact = message.headers.contact;
    if (contact) {
      const match = contact.match(/<([^>]+)>/);
      if (match?.[1]) dialog.remoteTarget = match[1];
    }
    const toTag = message.headers.to?.match(/tag=([^;\s]+)/)?.[1];
    const fromTag = message.headers.from?.match(/tag=([^;\s]+)/)?.[1];
    if (dialog.direction === "out" && toTag) dialog.remoteTag = toTag;
    if (dialog.direction === "in" && fromTag) dialog.remoteTag = fromTag;
  }

  private newDialog(direction: "in" | "out", target: string, peer: string, callId = `${randomBytes(8).toString("hex")}@${this.config.publicIp}`): Dialog {
    const dialog: Dialog = {
      callId,
      localTag: randomBytes(4).toString("hex"),
      remoteTarget: target,
      cseq: 1,
      direction,
      state: "proceeding",
      codec: this.config.codecs[0] ?? "PCMA",
      peer,
    };
    const rtp = dgram.createSocket("udp4");
    const port = this.allocRtp();
    rtp.bind(port, this.config.signalHost);
    rtp.on("message", (packet) => {
      if (packet.length < 12) return;
      const pt = packet[1]! & 0x7f;
      const codec: Codec = pt === 8 ? "PCMA" : "PCMU";
      this.emit("audio", { callId: dialog.callId, pcm: payloadToPcm(packet.subarray(12), codec) });
    });
    dialog.rtp = rtp;
    dialog.rtpPort = port;
    this.dialogs.set(callId, dialog);
    return dialog;
  }

  private allocRtp(): number {
    const port = this.nextRtp;
    this.nextRtp = port >= this.config.rtpPortMax ? this.config.rtpPortMin : port + 2;
    return port;
  }

  private sdp(dialog: Dialog): string {
    const payloads = this.config.codecs.map((codec) => (codec === "PCMA" ? "8" : "0")).join(" ");
    const maps = this.config.codecs.map((codec) => codec === "PCMA" ? "a=rtpmap:8 PCMA/8000" : "a=rtpmap:0 PCMU/8000");
    return [
      "v=0",
      `o=- ${Date.now()} 1 IN IP4 ${this.config.publicIp}`,
      "s=Hearth",
      `c=IN IP4 ${this.config.publicIp}`,
      "t=0 0",
      `m=audio ${dialog.rtpPort ?? 0} RTP/AVP ${payloads}`,
      ...maps,
      "a=sendrecv",
      "a=ptime:20",
    ].join("\r\n") + "\r\n";
  }

  private contact(): string {
    return `<sip:${this.config.callerId}@${this.config.publicIp}:${this.localPort()}>`;
  }

  private reply(request: SipMessage, status: number, reason: string, body = "", toTag?: string): void {
    const headers: Record<string, string> = {};
    for (const name of ["via", "from", "to", "call-id", "cseq"]) {
      const value = request.headers[name];
      if (value) headers[canonical(name)] = value;
    }
    if (toTag && headers.To && !/tag=/.test(headers.To)) headers.To = `${headers.To};tag=${toTag}`;
    headers.Contact = this.contact();
    if (body) headers["Content-Type"] = "application/sdp";
    this.send(buildSip({ start: `SIP/2.0 ${status} ${reason}`, headers, body }));
  }

  private send(message: string, host = this.config.proxyHost, port = this.config.proxyPort): void {
    this.socket?.send(message, port, host);
  }

  private sendAndWait(message: string, match: (parsed: SipMessage) => boolean, timeoutMs = 2000): Promise<SipMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("response", onResponse);
        reject(new Error("SIP timeout"));
      }, timeoutMs);
      const onResponse = (parsed: SipMessage) => {
        if (!match(parsed)) return;
        if (parsed.status === 100 || parsed.status === 180 || parsed.status === 183) return;
        clearTimeout(timer);
        this.off("response", onResponse);
        resolve(parsed);
      };
      this.on("response", onResponse);
      this.send(message);
    });
  }
}

function canonical(name: string): string {
  return name.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("-");
}

function userOf(header: string): string {
  const match = header.match(/sip:([^@>;]+)/);
  return match?.[1] ?? "unknown";
}

function parseSdp(body: string): { host: string; port: number } | undefined {
  const host = body.match(/^c=IN IP4 (\S+)/m)?.[1];
  const port = body.match(/^m=audio (\d+)/m)?.[1];
  if (!host || !port) return undefined;
  return { host, port: Number(port) };
}

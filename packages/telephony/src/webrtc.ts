import { MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket, usePCMU, type RTCIceServer } from "werift";
import { payloadToPcm, pcmToPayload } from "./g711.js";

export type WebRtcLeg = {
  answerSdp: string;
  sendPcm: (pcm: Int16Array) => void;
  close: () => Promise<void>;
};

/**
 * In-app user-to-agent voice. The browser is a WebRTC peer. This process
 * answers with PCMU only, so no SIP trunk and no native codec library is involved.
 * ICE candidates are gathered into the answer so mobile browsers can connect
 * without a second trickle channel.
 */
export type VoiceRtcOptions = {
  iceServers?: RTCIceServer[];
  icePortMin?: number;
  icePortMax?: number;
  publicIp?: string;
};

export async function answerUserVoice(offerSdp: string, onPcm: (pcm: Int16Array) => void, iceServersOrOptions: RTCIceServer[] | VoiceRtcOptions = []): Promise<WebRtcLeg> {
  if (!/m=audio/.test(offerSdp)) throw new Error("offer has no audio");
  const options: VoiceRtcOptions = Array.isArray(iceServersOrOptions) ? { iceServers: iceServersOrOptions } : iceServersOrOptions;
  const pc = new RTCPeerConnection({
    codecs: { audio: [usePCMU()] },
    iceServers: options.iceServers ?? [],
    ...(options.icePortMin && options.icePortMax && options.icePortMin <= options.icePortMax
      ? { icePortRange: [options.icePortMin, options.icePortMax] as [number, number], iceUseTcp: false }
      : {}),
    ...(options.publicIp ? { iceAdditionalHostAddresses: [options.publicIp] } : {}),
  });
  const outbound = new MediaStreamTrack({ kind: "audio" });
  pc.addTrack(outbound);
  pc.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      if (rtp.header.payloadType !== 0 || rtp.payload.length === 0) return;
      onPcm(payloadToPcm(rtp.payload, "PCMU"));
    });
  });
  await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  if (pc.iceGatheringState !== "complete") {
    await pc.iceGatheringStateChange.watch((state) => state === "complete", 4000).catch(() => undefined);
  }
  const sdp = pc.localDescription?.sdp;
  if (!sdp || !/a=rtpmap:0 PCMU\/8000/i.test(sdp)) throw new Error("answer did not negotiate PCMU");
  let sequence = Math.floor(Math.random() * 1000);
  let timestamp = Math.floor(Math.random() * 1000);
  return {
    answerSdp: sdp,
    sendPcm(pcm: Int16Array) {
      for (let offset = 0; offset < pcm.length; offset += 160) {
        const frame = pcm.subarray(offset, Math.min(offset + 160, pcm.length));
        const payload = pcmToPayload(frame.length === 160 ? frame : padFrame(frame), "PCMU");
        outbound.writeRtp(new RtpPacket(new RtpHeader({
          version: 2,
          payloadType: 0,
          sequenceNumber: sequence & 0xffff,
          timestamp: timestamp >>> 0,
          ssrc: 0x68656172,
        }), payload));
        sequence += 1;
        timestamp += 160;
      }
    },
    async close() {
      await pc.close();
    },
  };
}

function padFrame(frame: Int16Array): Int16Array {
  const padded = new Int16Array(160);
  padded.set(frame);
  return padded;
}

export function offerRequestsAudio(sdp: string): boolean {
  return /m=audio\s+\d+\s+UDP\/TLS\/RTP\/SAVPF/.test(sdp) || /m=audio\s+\d+\s+RTP\/AVP/.test(sdp);
}

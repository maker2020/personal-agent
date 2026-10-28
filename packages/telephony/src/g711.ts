const SEG_END = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff];

function searchSeg(value: number): number {
  for (let i = 0; i < SEG_END.length; i += 1) {
    if (value <= (SEG_END[i] ?? 0)) return i;
  }
  return 8;
}

/** ITU-T G.711 A-law, public-domain Sun-style mapping. 0 encodes to 0xD5. */
export function linearToAlaw(sample: number): number {
  let pcm = Math.max(-32768, Math.min(32767, sample | 0));
  let mask: number;
  if (pcm >= 0) mask = 0xd5;
  else {
    mask = 0x55;
    pcm = -pcm - 1;
  }
  const seg = searchSeg(pcm);
  if (seg >= 8) return (0x7f ^ mask) & 0xff;
  let aval = seg << 4;
  aval |= seg < 2 ? (pcm >> 4) & 0x0f : (pcm >> (seg + 3)) & 0x0f;
  return (aval ^ mask) & 0xff;
}

export function alawToLinear(alaw: number): number {
  const value = alaw ^ 0x55;
  const quant = value & 0x0f;
  const seg = (value & 0x70) >> 4;
  let sample = quant << 4;
  switch (seg) {
    case 0:
      sample += 8;
      break;
    case 1:
      sample += 0x108;
      break;
    default:
      sample += 0x108;
      sample <<= seg - 1;
      break;
  }
  return (value & 0x80) !== 0 ? sample : -sample;
}

/** ITU-T G.711 μ-law. 0 encodes to 0xFF. */
export function linearToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let pcm = sample | 0;
  const sign = (pcm >> 8) & 0x80;
  if (sign !== 0) pcm = -pcm;
  if (pcm > CLIP) pcm = CLIP;
  pcm += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (pcm & mask) === 0 && exponent > 0; exponent -= 1, mask >>= 1) {
    /* scan */
  }
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

export function mulawToLinear(mulaw: number): number {
  const BIAS = 0x84;
  const value = (~mulaw) & 0xff;
  const exponent = (value & 0x70) >> 4;
  const mantissa = value & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return (value & 0x80) !== 0 ? -sample : sample;
}

export function pcmToPayload(pcm: Int16Array, codec: "PCMA" | "PCMU"): Buffer {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    const sample = pcm[i] ?? 0;
    out[i] = codec === "PCMA" ? linearToAlaw(sample) : linearToMulaw(sample);
  }
  return out;
}

export function payloadToPcm(payload: Buffer, codec: "PCMA" | "PCMU"): Int16Array {
  const out = new Int16Array(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    const byte = payload[i] ?? 0;
    out[i] = codec === "PCMA" ? alawToLinear(byte) : mulawToLinear(byte);
  }
  return out;
}

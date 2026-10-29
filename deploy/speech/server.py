#!/usr/bin/env python3
"""Small speech sidecar: Vosk over WebSocket, Edge TTS over HTTP.

One process keeps the memory budget to the small Chinese Vosk model.
No host ports are published; the gateway calls it on the compose network.
"""
import asyncio
import json
import os
import sys

from aiohttp import WSMsgType, web

try:
    import edge_tts
    import vosk
except ImportError as exc:
    print(f"speech sidecar missing dependency: {exc}", file=sys.stderr)
    raise

MODEL_PATH = os.environ.get("VOSK_MODEL", "/models/vosk-model-small-cn-0.22")
PORT = int(os.environ.get("SPEECH_PORT", "2700"))
DEFAULT_VOICE = os.environ.get("EDGE_VOICE", "zh-CN-XiaoxiaoNeural")

model = None


def load_model():
    global model
    if not os.path.isdir(MODEL_PATH):
        print(f"vosk model directory not found: {MODEL_PATH}", file=sys.stderr)
        print("download vosk-model-small-cn-0.22 into the mounted model directory", file=sys.stderr)
        sys.exit(1)
    model = vosk.Model(MODEL_PATH)
    print(f"vosk model loaded from {MODEL_PATH}", flush=True)


async def health(_request):
    if model is None:
        return web.json_response({"ok": False}, status=503)
    return web.json_response({"ok": True, "asr": "vosk", "tts": "edge"})


async def asr(request):
    if model is None:
        return web.json_response({"error": "model not loaded"}, status=503)
    socket = web.WebSocketResponse()
    await socket.prepare(request)
    recognizer = vosk.KaldiRecognizer(model, 16000)
    async for message in socket:
        if message.type == WSMsgType.TEXT:
            try:
                payload = json.loads(message.data)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict) and "config" in payload:
                rate = int((payload.get("config") or {}).get("sample_rate") or 16000)
                recognizer = vosk.KaldiRecognizer(model, rate)
            elif isinstance(payload, dict) and payload.get("eof"):
                await socket.send_str(recognizer.FinalResult())
                break
        elif message.type == WSMsgType.BINARY:
            audio = message.data
            if recognizer.AcceptWaveform(audio):
                await socket.send_str(recognizer.Result())
            else:
                await socket.send_str(recognizer.PartialResult())
        elif message.type == WSMsgType.ERROR:
            print(f"vosk websocket error: {socket.exception()}", file=sys.stderr)
            break
    return socket


async def tts(request):
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "bad json"}, status=400)
    text = str(body.get("text") or "").strip()
    if not text:
        return web.Response(body=b"", content_type="application/octet-stream")
    voice = str(body.get("voice") or DEFAULT_VOICE)
    rate = str(body.get("rate") or "+0%")
    pitch = str(body.get("pitch") or "+0Hz")
    try:
        mp3 = bytearray()
        communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                mp3.extend(chunk["data"])
        if not mp3:
            print("edge-tts returned no audio", file=sys.stderr)
            return web.json_response({"error": "empty audio"}, status=502)
        process = await asyncio.create_subprocess_exec(
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", "8000", "pipe:1",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        pcm, err = await process.communicate(bytes(mp3))
        if process.returncode != 0:
            detail = (err or b"").decode("utf-8", "replace")[:300]
            print(f"ffmpeg failed: {detail}", file=sys.stderr)
            return web.json_response({"error": "resample failed"}, status=502)
        return web.Response(body=pcm, content_type="application/octet-stream")
    except Exception as exc:
        print(f"edge-tts failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return web.json_response({"error": "tts failed"}, status=502)


def main():
    load_model()
    app = web.Application()
    app.router.add_get("/healthz", health)
    app.router.add_post("/tts", tts)
    app.router.add_get("/", asr)
    app.router.add_get("/asr", asr)
    web.run_app(app, host="0.0.0.0", port=PORT, print=lambda *_: None)


if __name__ == "__main__":
    main()

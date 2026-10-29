const dict = {
  zh: { title: "守望", chat: "对话", approvals: "审批", phone: "语音", watch: "哨兵", login: "登录", user: "用户名", password: "密码", send: "发送", placeholder: "让 Hearth 去做一件事", pending: "待审批", approve: "同意", reject: "拒绝", empty: "还没有内容", sentinel: "哨兵状态", sms: "短信", calls: "通话", startCall: "和助手通话", hangup: "挂断", voice: "应用内语音" },
  en: { title: "Hearth", chat: "Chat", approvals: "Approvals", phone: "Voice", watch: "Sentinel", login: "Sign in", user: "Username", password: "Password", send: "Send", placeholder: "Ask Hearth to do something", pending: "Pending", approve: "Approve", reject: "Reject", empty: "Nothing yet", sentinel: "Sentinel", sms: "SMS", calls: "Calls", startCall: "Call your agent", hangup: "Hang up", voice: "In-app voice" },
};
const state = { lang: localStorage.getItem("hearth.lang") || "zh", tab: "chat", token: localStorage.getItem("hearth.token") || "", sessionId: "", messages: [], iceServers: [], pc: null, voiceId: "" };
const $ = (id) => document.getElementById(id);
const t = (key) => dict[state.lang][key];

function headers() {
  return { "content-type": "application/json", ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) };
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(body.error || response.statusText);
  return body;
}

function render() {
  $("title").textContent = t("title");
  $("lang").textContent = state.lang === "zh" ? "EN" : "中文";
  document.querySelectorAll(".tabs button").forEach((button) => {
    button.textContent = t(button.dataset.tab);
    button.classList.toggle("active", button.dataset.tab === state.tab);
  });
  if (!state.token) return login();
  if (state.tab === "chat") return chat();
  if (state.tab === "approvals") return approvals();
  if (state.tab === "phone") return phone();
  return watch();
}

function login() {
  $("app").innerHTML = `<form class="card" id="form"><label>${t("user")}</label><input name="username" autocomplete="username" /><label>${t("password")}</label><input name="password" type="password" autocomplete="current-password" /><label>${state.lang === "zh" ? "邀请码（注册时填写）" : "Invite code (signup)"}</label><input name="invite" /><button type="submit">${t("login")}</button><button type="button" id="signup">${state.lang === "zh" ? "注册" : "Sign up"}</button></form>`;
  $("form").onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    const body = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: data.get("username"), password: data.get("password") }) });
    state.token = body.token;
    localStorage.setItem("hearth.token", body.token);
    render();
  };
  $("signup").onclick = async () => {
    const data = new FormData($("form"));
    const body = await api("/api/auth/signup", { method: "POST", body: JSON.stringify({ username: data.get("username"), password: data.get("password"), invite: data.get("invite") }) });
    state.token = body.token;
    localStorage.setItem("hearth.token", body.token);
    render();
  };
}

async function chat() {
  if (!state.sessionId) {
    const sessions = await api("/api/sessions");
    const existing = (sessions.sessions || []).find((item) => item.kind === "chat");
    state.sessionId = existing ? existing.id : (await api("/api/sessions", { method: "POST", body: JSON.stringify({ title: t("chat") }) })).id;
  }
  const history = await api(`/api/sessions/${state.sessionId}/messages`);
  state.messages = history.messages || [];
  $("app").innerHTML = `<section class="messages" id="log"></section><form id="form" class="row"><input name="text" placeholder="${t("placeholder")}" /><button type="submit">${t("send")}</button></form>`;
  paint();
  $("form").onsubmit = async (event) => {
    event.preventDefault();
    const text = new FormData(event.target).get("text");
    event.target.reset();
    state.messages.push({ role: "user", content: text });
    const draft = { role: "assistant", content: "" };
    state.messages.push(draft);
    paint();
    const response = await fetch(`/api/sessions/${state.sessionId}/messages`, { method: "POST", headers: headers(), body: JSON.stringify({ text }) });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";
      for (const frame of frames) {
        const data = frame.split("\n").find((line) => line.startsWith("data:"));
        if (!data) continue;
        const payload = JSON.parse(data.slice(5));
        if (frame.includes("event: token")) draft.content += payload.text || "";
        if (frame.includes("event: done")) draft.content = payload.text || draft.content;
        if (frame.includes("event: error")) draft.content = payload.error || "error";
        paint();
      }
    }
  };
}

function paint() {
  const log = $("log");
  if (!log) return;
  log.innerHTML = state.messages.filter((item) => item.role !== "tool").map((item) => `<div class="bubble ${item.role === "user" ? "user" : ""}">${escapeHtml(item.content || "")}</div>`).join("") || `<p class="meta">${t("empty")}</p>`;
  log.scrollTop = log.scrollHeight;
}

async function approvals() {
  const body = await api("/api/approvals?status=pending");
  const items = body.approvals || [];
  $("app").innerHTML = items.length ? items.map((item) => `<article class="card"><strong>${escapeHtml(item.kind)}</strong><p>${escapeHtml(item.reason)}</p><pre class="meta">${escapeHtml(JSON.stringify(item.payload, null, 2))}</pre><div class="row"><button data-id="${item.id}" data-decision="approved">${t("approve")}</button><button class="ghost" data-id="${item.id}" data-decision="rejected">${t("reject")}</button></div></article>`).join("") : `<p class="card">${t("empty")}</p>`;
  $("app").querySelectorAll("button[data-id]").forEach((button) => {
    button.onclick = async () => {
      await api(`/api/approvals/${button.dataset.id}/decision`, { method: "POST", body: JSON.stringify({ decision: button.dataset.decision }) });
      approvals();
    };
  });
}

async function phone() {
  const me = await api("/api/me");
  const voice = await api("/api/voice/config");
  state.iceServers = voice.iceServers || [];
  const pstn = me.pstn
    ? `<section class="card"><h2>PSTN</h2><p class="meta">${state.lang === "zh" ? "企业线路已开通。真实号码由平台共享网关拨出，助手进程里没有 SIP 账号。" : "Enterprise trunk is on. Real numbers are dialed by the shared gateway. This agent has no SIP credentials."}</p></section>`
    : `<section class="card"><p class="meta">${state.lang === "zh" ? "拨打真实电话是企业版能力，默认关闭。" : "Calling real phone numbers is an enterprise feature and stays off."}</p></section>`;
  const sms = me.sms
    ? ""
    : `<section class="card"><p class="meta">${state.lang === "zh" ? "短信是企业版能力，默认关闭。" : "SMS is an enterprise feature and stays off."}</p></section>`;
  const missing = voice.asr === false || voice.tts === false
    ? `<p class="meta">${state.lang === "zh" ? "语音识别/合成未配置" : "Speech recognition or synthesis is not configured."}</p>`
    : "";
  $("app").innerHTML = `<section class="card"><h2>${t("voice")}</h2><p class="meta">${state.lang === "zh" ? "这是你和自己的助手之间的网络通话，不占用电话号码。" : "This is a network call between you and your own agent. It does not use a phone number."}</p>${missing}<button id="call" class="call" type="button">${t("startCall")}</button><p id="call-state" class="meta"></p><audio id="remote" autoplay playsinline></audio></section>${pstn}${sms}`;
  $("call").onclick = () => toggleCall();
}

async function toggleCall() {
  if (state.pc) {
    state.pc.close();
    state.pc = null;
    if (state.voiceId) await api(`/api/voice/calls/${state.voiceId}`, { method: "DELETE" }).catch(() => ({}));
    state.voiceId = "";
    $("call").textContent = t("startCall");
    $("call-state").textContent = "";
    return;
  }
  const status = $("call-state");
  status.textContent = state.lang === "zh" ? "正在连接…" : "Connecting…";
  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  state.pc = pc;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false });
  for (const track of stream.getTracks()) pc.addTrack(track, stream);
  const transceiver = pc.getTransceivers().find((item) => item.sender.track && item.sender.track.kind === "audio");
  const caps = window.RTCRtpSender && RTCRtpSender.getCapabilities ? RTCRtpSender.getCapabilities("audio") : null;
  if (transceiver && transceiver.setCodecPreferences && caps) {
    const pcmu = caps.codecs.filter((codec) => /pcmu/i.test(codec.mimeType));
    const rest = caps.codecs.filter((codec) => !/pcmu/i.test(codec.mimeType));
    if (pcmu.length) transceiver.setCodecPreferences(pcmu.concat(rest));
  }
  pc.ontrack = (event) => {
    const audio = $("remote");
    audio.srcObject = event.streams[0] || new MediaStream([event.track]);
    audio.play().catch(() => {});
    status.textContent = state.lang === "zh" ? "通话中" : "Live";
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const timer = setTimeout(resolve, 2500);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        resolve();
      }
    };
  });
  const answered = await api("/api/voice/calls", { method: "POST", body: JSON.stringify({ sdp: pc.localDescription.sdp }) });
  state.voiceId = answered.id;
  await pc.setRemoteDescription({ type: "answer", sdp: answered.sdp });
  $("call").textContent = t("hangup");
  if (!status.textContent || status.textContent.includes("连接") || status.textContent.includes("Connect")) status.textContent = state.lang === "zh" ? "已接通" : "Connected";
}

async function watch() {
  const body = await api("/api/sentinel");
  $("app").innerHTML = `<section class="card"><h2>${t("sentinel")}</h2><p>email: ${body.email ? "on" : "off"}</p><p>sms: ${escapeHtml(body.sms)}</p><p>sip: ${body.sip ? "on" : "off"}</p><p class="meta">poll ${body.pollMs} ms</p></section>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

$("lang").onclick = () => {
  state.lang = state.lang === "zh" ? "en" : "zh";
  localStorage.setItem("hearth.lang", state.lang);
  render();
};
document.querySelectorAll(".tabs button").forEach((button) => {
  button.onclick = () => { state.tab = button.dataset.tab; render(); };
});
render();

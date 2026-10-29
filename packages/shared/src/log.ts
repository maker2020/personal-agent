const SECRET = /api[-_]?key|password|secret|token|authorization|cookie|credential/i;

export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => void;
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
  child: (name: string) => Logger;
};

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (typeof value === "string") {
    const scrubbed = value
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
      .replace(/\b(AKIA|LTAI)[A-Za-z0-9]{8,}/g, "[redacted]");
    return scrubbed.length > 2000 ? `${scrubbed.slice(0, 2000)}…` : scrubbed;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET.test(key) ? "[redacted]" : redact(item, depth + 1);
  }
  return out;
}

export function createLogger(name: string, level: LogLevel = "info"): Logger {
  const rank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const write = (at: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (rank[at] < rank[level]) return;
    const line = {
      ts: new Date().toISOString(),
      level: at,
      name,
      msg,
      ...(fields ? { fields: redact(fields) } : {}),
    };
    const sink = at === "error" || at === "warn" ? console.error : console.log;
    sink(JSON.stringify(line));
  };
  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    child: (child) => createLogger(`${name}.${child}`, level),
  };
}

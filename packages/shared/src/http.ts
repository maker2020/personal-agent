import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { safeEqual } from "./auth.js";

export type HttpRequest = {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: unknown;
  rawBody: string;
  remote: string;
};

export type HttpResponse = {
  status: (code: number) => HttpResponse;
  json: (value: unknown) => void;
  text: (value: string, type?: string) => void;
  sse: () => SseStream;
  raw: ServerResponse;
};

export type SseStream = {
  send: (event: string, data: unknown) => void;
  end: () => void;
};

export type RouteHandler = (req: HttpRequest, res: HttpResponse) => Promise<void> | void;

type Route = { method: string; parts: string[]; handler: RouteHandler };

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: RouteHandler): void {
    this.routes.push({ method: method.toUpperCase(), parts: path.split("/").filter(Boolean), handler });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const method = (req.method ?? "GET").toUpperCase();
    const rawBody = await readBody(req);
    let body: unknown = undefined;
    const type = String(req.headers["content-type"] ?? "");
    if (rawBody && type.includes("application/json")) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = undefined;
      }
    } else if (rawBody && type.includes("application/x-www-form-urlencoded")) {
      body = Object.fromEntries(new URLSearchParams(rawBody));
    }
    const request: HttpRequest = {
      method,
      path: url.pathname,
      params: {},
      query: url.searchParams,
      headers: req.headers,
      body,
      rawBody,
      remote: req.socket.remoteAddress ?? "",
    };
    const response = createResponse(res);
    if (method === "OPTIONS") {
      response.status(204).text("");
      return;
    }
    for (const route of this.routes) {
      if (route.method !== method || route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.parts.length; i += 1) {
        const expected = route.parts[i] ?? "";
        const actual = parts[i] ?? "";
        if (expected.startsWith(":")) params[expected.slice(1)] = decodeURIComponent(actual);
        else if (expected !== actual) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      request.params = params;
      await route.handler(request, response);
      return;
    }
    response.status(404).json({ error: "not_found" });
  }
}

function createResponse(res: ServerResponse): HttpResponse {
  const api: HttpResponse = {
    raw: res,
    status(code) {
      res.statusCode = code;
      return api;
    },
    json(value) {
      if (!res.headersSent) {
        res.setHeader("content-type", "application/json; charset=utf-8");
      }
      res.end(JSON.stringify(value));
    },
    text(value, type = "text/plain; charset=utf-8") {
      if (!res.headersSent) res.setHeader("content-type", type);
      res.end(value);
    },
    sse() {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      return {
        send(event, data) {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        },
        end() {
          res.end();
        },
      };
    },
  };
  return api;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function listen(router: Router, host: string, port: number): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    router.handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      const message = error instanceof Error ? error.message : "internal error";
      res.end(JSON.stringify({ error: message === "body too large" ? "body_too_large" : "internal" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      resolve({ server, port: actual });
    });
  });
}

export function bearer(req: HttpRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return undefined;
  return token;
}

export function authorizedInternal(req: HttpRequest, token: string): boolean {
  const presented = bearer(req) ?? req.headers["x-hearth-token"];
  if (typeof presented !== "string" || !presented) return false;
  return safeEqual(presented, token);
}

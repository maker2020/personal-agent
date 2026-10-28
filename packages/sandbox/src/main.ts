import { createLogger, listen, Router, authorizedInternal, loadConfig } from "../../shared/src/index.js";
import { openStore } from "../../store/src/index.js";
import { DockerSandbox, PlacementRouter } from "./index.js";

const config = loadConfig(process.env);
if (config.sandbox.backend !== "docker") {
  console.error("sandbox manager requires HEARTH_SANDBOX=docker");
  process.exit(1);
}
const logger = createLogger("sandbox", config.logLevel);
const store = await openStore(config.databaseUrl);
await store.migrate();
const docker = new DockerSandbox(config.sandbox.workspaceRoot, config.sandbox.dockerImage);
const routerBackend = new PlacementRouter(store, config.sandbox.nodeId, docker, config.sandbox.advertiseUrl);
const router = new Router();
router.add("GET", "/healthz", async (_req, res) => res.json({ ok: true, service: "sandbox" }));
router.add("POST", "/internal/sandbox/ensure", async (req, res) => {
  if (!authorizedInternal(req, config.internalToken)) return res.status(401).json({ error: "unauthorized" });
  res.json(await routerBackend.ensure(String((req.body as { userId?: string })?.userId ?? "")));
});
router.add("POST", "/internal/sandbox/exec", async (req, res) => {
  if (!authorizedInternal(req, config.internalToken)) return res.status(401).json({ error: "unauthorized" });
  const body = req.body as { userId?: string; command?: string; timeoutMs?: number };
  res.json(await routerBackend.exec(String(body.userId ?? ""), String(body.command ?? ""), Number(body.timeoutMs ?? 15000)));
});
router.add("POST", "/internal/sandbox/read", async (req, res) => {
  if (!authorizedInternal(req, config.internalToken)) return res.status(401).json({ error: "unauthorized" });
  const body = req.body as { userId?: string; path?: string };
  res.json({ content: await routerBackend.backendRead(String(body.userId ?? ""), String(body.path ?? "")) });
});
router.add("POST", "/internal/sandbox/write", async (req, res) => {
  if (!authorizedInternal(req, config.internalToken)) return res.status(401).json({ error: "unauthorized" });
  const body = req.body as { userId?: string; path?: string; content?: string };
  await routerBackend.backendWrite(String(body.userId ?? ""), String(body.path ?? ""), String(body.content ?? ""));
  res.json({ ok: true });
});
const port = Number(process.env.HEARTH_SANDBOX_PORT ?? 8790);
const bound = await listen(router, "0.0.0.0", port);
logger.info("sandbox manager listening", { port: bound.port, workspaceRoot: config.sandbox.workspaceRoot });

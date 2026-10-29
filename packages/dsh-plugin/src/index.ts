import { defineTool } from "@deepseek-ai/dsh-tools";
import { TOOL_SPECS } from "../../tools/src/registry.js";

export const name = "hearth-tools";
export const inject = ["tools"];

type ToolsHost = {
  tools?: { register: (definition: unknown) => () => void };
  logger?: { info: (message: string) => void };
};

type PluginConfig = { internalUrl?: string; internalToken?: string; userId?: string };

/**
 * Out-of-tree dsh bundle. Tool bodies call back into the Hearth gateway so the
 * harness loop and the personal client share one approval and perception path.
 */
export function apply(ctx: ToolsHost, config: PluginConfig = {}): void {
  if (!ctx.tools) throw new Error("hearth-tools requires ctx.tools");
  const internalUrl = config.internalUrl ?? process.env.HEARTH_INTERNAL_URL ?? "http://127.0.0.1:8787";
  const token = config.internalToken ?? process.env.HEARTH_INTERNAL_TOKEN ?? "";
  const userId = config.userId ?? process.env.HEARTH_USER_ID ?? "owner";
  for (const spec of TOOL_SPECS) {
    try {
      ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: toParameters(spec.input_schema),
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const response = await fetch(`${internalUrl.replace(/\/$/, "")}/internal/tools/invoke`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ userId, name: spec.name, input: args }),
          signal: exec.signal,
        });
        const payload: unknown = await response.json();
        return JSON.parse(JSON.stringify(payload ?? null));
      },
    }));
    } catch (error) {
      console.error(`hearth-tools skipped ${spec.name}: ${error instanceof Error ? error.message : "register failed"}`);
    }
  }
  console.error("hearth-plugin-ready");
  ctx.logger?.info("hearth-plugin-ready");
}

function toParameters(schema: Record<string, unknown>): Record<string, { type: "string" | "number" | "boolean" | "json"; description: string; required?: true }> {
  const properties = (schema.properties ?? {}) as Record<string, { type?: string; description?: string }>;
  const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
  const parameters: Record<string, { type: "string" | "number" | "boolean" | "json"; description: string; required?: true }> = {};
  for (const [key, value] of Object.entries(properties)) {
    const type = value.type === "number" || value.type === "integer" ? "number" : value.type === "boolean" ? "boolean" : value.type === "object" ? "json" : "string";
    parameters[key] = { type, description: value.description ?? key };
    if (required.has(key)) parameters[key].required = true;
  }
  return parameters;
}

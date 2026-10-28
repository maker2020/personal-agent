export type LlmTool = { name: string; description: string; input_schema: Record<string, unknown> };

export type LlmMessage = {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

export type LlmEvent =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; input: Record<string, unknown> }
  | { type: "done" };

export interface LlmClient {
  stream(input: { system: string; messages: LlmMessage[]; tools: LlmTool[]; maxTokens?: number }): AsyncGenerator<LlmEvent>;
}

export class MockLlm implements LlmClient {
  async *stream(input: { messages: LlmMessage[] }): AsyncGenerator<LlmEvent> {
    const last = input.messages[input.messages.length - 1];
    const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
    const tool = text.match(/^\/tool\s+(\w+)\s+([\s\S]*)$/);
    if (tool) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tool[2] ?? "{}") as Record<string, unknown>; } catch { args = { text: tool[2] }; }
      yield { type: "tool", id: "mock-tool-1", name: tool[1] ?? "tool", input: args };
      yield { type: "done" };
      return;
    }
    const reply = `收到：${text}`;
    for (const part of reply.match(/.{1,12}/gs) ?? [reply]) yield { type: "text", text: part };
    yield { type: "done" };
  }
}

export class DeepSeekMessages implements LlmClient {
  constructor(private opts: { apiKey: string; baseUrl: string; model: string; thinking: "enabled" | "disabled"; maxTokens: number; fetchImpl?: typeof fetch }) {}

  async *stream(input: { system: string; messages: LlmMessage[]; tools: LlmTool[]; maxTokens?: number }): AsyncGenerator<LlmEvent> {
    const root = this.opts.baseUrl.replace(/\/$/, "").replace(/\/v1$/, "");
    const response = await (this.opts.fetchImpl ?? fetch)(`${root}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.opts.apiKey,
        "anthropic-version": "2023-06-01",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: this.opts.model,
        max_tokens: input.maxTokens ?? this.opts.maxTokens,
        stream: true,
        system: input.system,
        messages: input.messages,
        tools: input.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })),
        thinking: { type: this.opts.thinking === "enabled" ? "enabled" : "disabled" },
      }),
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error(`DeepSeek messages failed (${response.status}) ${detail.slice(0, 300).replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")}`);
    }
    let toolId = "";
    let toolName = "";
    let toolJson = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const event = JSON.parse(data) as { type?: string; delta?: { type?: string; text?: string; partial_json?: string }; content_block?: { type?: string; id?: string; name?: string } };
        if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          toolId = event.content_block.id ?? "";
          toolName = event.content_block.name ?? "";
          toolJson = "";
        } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          yield { type: "text", text: event.delta.text };
        } else if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
          toolJson += event.delta.partial_json ?? "";
        } else if (event.type === "content_block_stop" && toolName) {
          let inputJson: Record<string, unknown> = {};
          try { inputJson = toolJson ? JSON.parse(toolJson) as Record<string, unknown> : {}; } catch { inputJson = {}; }
          yield { type: "tool", id: toolId || toolName, name: toolName, input: inputJson };
          toolName = "";
          toolJson = "";
        }
      }
    }
    yield { type: "done" };
  }
}

export function parseSseFixture(raw: string): LlmEvent[] {
  const events: LlmEvent[] = [];
  let toolName = "";
  let toolId = "";
  let toolJson = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    const event = JSON.parse(data) as { type?: string; delta?: { type?: string; text?: string; partial_json?: string }; content_block?: { type?: string; id?: string; name?: string } };
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      toolId = event.content_block.id ?? "";
      toolName = event.content_block.name ?? "";
      toolJson = "";
    } else if (event.delta?.type === "text_delta" && event.delta.text) events.push({ type: "text", text: event.delta.text });
    else if (event.delta?.type === "input_json_delta") toolJson += event.delta.partial_json ?? "";
    else if (event.type === "content_block_stop" && toolName) {
      events.push({ type: "tool", id: toolId, name: toolName, input: JSON.parse(toolJson || "{}") as Record<string, unknown> });
      toolName = "";
    }
  }
  events.push({ type: "done" });
  return events;
}

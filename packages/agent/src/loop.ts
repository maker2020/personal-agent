import type { Store } from "../../store/src/types.js";
import type { LlmClient, LlmMessage } from "../../llm/src/index.js";
import { TOOL_SPECS, invokeTool, type ToolHost } from "../../tools/src/registry.js";

const SYSTEM = `You are Hearth, a personal assistant. You can read and draft email, send templated SMS, place phone calls, browse public web pages, use the user's private workspace, and schedule routines. Sending email, SMS, and outbound calls waits for the user's approval unless they already approved. Do not invent credentials. Reply in the user's language.`;

export async function runTurn(input: {
  store: Store;
  host: ToolHost;
  llm: LlmClient;
  conversationId: string;
  text: string;
  source?: string;
  onToken?: (text: string) => void;
}): Promise<{ text: string }> {
  await input.store.appendMessage({ conversationId: input.conversationId, role: "user", content: input.source ? `[${input.source}] ${input.text}` : input.text });
  const history = await input.store.listMessages(input.conversationId);
  const messages = toLlm(history);
  let finalText = "";
  for (let step = 0; step < 6; step += 1) {
    let text = "";
    const tools: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    for await (const event of input.llm.stream({ system: SYSTEM, messages, tools: TOOL_SPECS })) {
      if (event.type === "text") {
        text += event.text;
        input.onToken?.(event.text);
      } else if (event.type === "tool") tools.push({ id: event.id, name: event.name, input: event.input });
    }
    if (tools.length === 0) {
      finalText = text;
      await input.store.appendMessage({ conversationId: input.conversationId, role: "assistant", content: text });
      break;
    }
    await input.store.appendMessage({ conversationId: input.conversationId, role: "assistant", content: text, toolCalls: tools });
    messages.push({ role: "assistant", content: [
      ...(text ? [{ type: "text", text }] : []),
      ...tools.map((tool) => ({ type: "tool_use", id: tool.id, name: tool.name, input: tool.input })),
    ] });
    const results = [];
    for (const tool of tools) {
      const output = await invokeTool(input.host, tool.name, tool.input);
      const rendered = JSON.stringify(output);
      results.push({ type: "tool_result", tool_use_id: tool.id, content: rendered });
      await input.store.appendMessage({ conversationId: input.conversationId, role: "tool", content: rendered, toolCallId: tool.id });
    }
    messages.push({ role: "user", content: results });
    finalText = text;
  }
  await input.store.touchConversation(input.conversationId);
  return { text: finalText };
}

function toLlm(history: Array<{ role: string; content: string; toolCalls?: Array<{ id: string; name: string; input: unknown }>; toolCallId?: string }>): LlmMessage[] {
  const messages: LlmMessage[] = [];
  for (const message of history) {
    if (message.role === "user") messages.push({ role: "user", content: message.content });
    else if (message.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const tool of message.toolCalls ?? []) blocks.push({ type: "tool_use", id: tool.id, name: tool.name, input: tool.input });
      messages.push({ role: "assistant", content: blocks.length ? blocks : message.content });
    } else if (message.role === "tool" && message.toolCallId) {
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }] });
    }
  }
  return messages;
}

export { SYSTEM };

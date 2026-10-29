import assert from "node:assert/strict";
import test from "node:test";
import { isPrivateAddress } from "../packages/tools/src/web.js";
import { parseSseFixture } from "../packages/llm/src/index.js";
import { nextRun } from "../packages/sentinel/src/schedule.js";
import { TaskMemory, createCheckpointer } from "../packages/memory/src/index.js";

test("ssrf guard rejects loopback", () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
});

test("sse fixture yields text and a tool call", () => {
  const events = parseSseFixture([
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
    'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"t1","name":"web_fetch"}}',
    'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"url\\":\\"https://example.com\\"}"}}',
    'data: {"type":"content_block_stop"}',
  ].join("\n"));
  assert.equal(events[0]?.type, "text");
  assert.equal(events.find((event) => event.type === "tool") && "name" in (events.find((event) => event.type === "tool") ?? {}), true);
});

test("daily schedule moves to the next day when the hour has passed", () => {
  const from = new Date("2026-10-28T09:00:00");
  const next = nextRun("daily:08:00", from);
  assert.equal(next.getDate(), 29);
});

test("a new memory graph resumes notes from the same checkpointer", async () => {
  const saver = await createCheckpointer();
  const first = new TaskMemory(saver);
  await first.remember("conversation-1", "resume-me");
  const second = new TaskMemory(saver);
  const notes = await second.recall("conversation-1");
  assert.equal(notes.at(-1)?.text, "resume-me");
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { test } from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { apply } from "./library-tools.ts";

function mount() {
  const tools = new Map<string, ToolDefinition>();
  const listeners = new Map<string, (...args: never[]) => unknown>();
  apply({
    tools: { register: (tool: ToolDefinition) => tools.set(tool.name, tool) },
    on: (name: string, listener: (...args: never[]) => unknown) => listeners.set(name, listener),
  } as unknown as Context);
  return { tools, listeners };
}

test("limits model requests per turn, including retries", () => {
  const { listeners } = mount();
  const session = { id: "session-id" };
  const sessionEvent = listeners.get("session/event") as (session: { id: string }, event: { type: string }) => void;
  const stream = listeners.get("llm/stream") as (options: { sessionId: string }, next: () => void) => void;
  const options = { sessionId: session.id };
  let requests = 0;
  const next = () => { requests++; };

  sessionEvent(session, { type: "turn/start" });
  for (let index = 0; index < 8; index++) stream(options, next);
  assert.throws(() => stream(options, next), { code: "REQUEST_LIMIT" });
  assert.equal(requests, 8);
  sessionEvent(session, { type: "turn/end" });
  sessionEvent(session, { type: "turn/start" });
  stream(options, next);
  assert.equal(requests, 9);
});

test("returns the rbxport response and reports an unavailable Windows pipe", { skip: process.platform !== "win32" }, async () => {
  const { tools } = mount();
  assert.equal(tools.size, 8);
  const pipe = `\\\\.\\pipe\\rbxport-agent-test-${randomUUID()}`;
  const token = randomUUID();
  process.env.RBXPORT_AGENT_PIPE = pipe;
  process.env.RBXPORT_AGENT_TOKEN = token;
  const output = { ok: true, data: { total: 1 } };
  const server = createServer((socket) => {
    createInterface({ input: socket }).once("line", (line) => {
      const request = JSON.parse(line);
      assert.equal(request.token, token);
      assert.equal(request.tool, "search_tracks");
      assert.deepEqual(request.arguments, { bpm: 125 });
      socket.end(JSON.stringify({ requestId: request.requestId, result: output }) + "\n");
    });
  });

  server.listen(pipe);
  await once(server, "listening");
  const tool = tools.get("search_tracks");
  assert.ok(tool);
  const execute = () => tool.execute(
    { bpm: 125 },
    { signal: AbortSignal.timeout(2000) } as Parameters<ToolDefinition["execute"]>[1],
  );
  try {
    assert.deepEqual(await execute(), output);
    server.close();
    await once(server, "close");
    assert.deepEqual(await execute(), {
      ok: false,
      error: { code: "bridge_unavailable", message: "The rbxport desktop bridge did not return a result." },
    });
  } finally {
    server.close();
    delete process.env.RBXPORT_AGENT_PIPE;
    delete process.env.RBXPORT_AGENT_TOKEN;
  }
});

import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import type { Context } from "@deepseek-ai/cordis";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";

export const name = "rbxport-library-tools";
export const inject = ["tools", "llm", "sessions", "systemPrompt"];

const string = { type: "string" } as const;
const integer = { type: "integer" } as const;
const requiredString = { ...string, required: true } as const;
const trackIds = { type: "array", items: string } as const;

const tools = [
  {
    name: "get_ui_context",
    description: "Get the current rbxport browser, search, filters, and selected tracks.",
    parameters: {},
  },
  {
    name: "search_tracks",
    description: "Find one page of tracks by keyword, whole BPM, or playlist. Defaults to the whole collection and returns total and nextOffset.",
    parameters: { query: string, bpm: integer, playlistId: string, offset: integer, limit: integer },
  },
  {
    name: "list_playlists",
    description: "Search playlists and folders. Use the returned IDs and folder paths to distinguish identically named items.",
    parameters: { query: string },
  },
  {
    name: "get_track_details",
    description: "Read metadata of a track by its rbxport track ID.",
    parameters: { trackId: requiredString },
  },
  {
    name: "open_playlist",
    description: "Open an existing playlist in the main rbxport browser.",
    parameters: { playlistId: requiredString },
  },
  {
    name: "create_playlist",
    description: "Create an ordinary playlist in the given folder or at the root. Returns the new playlist ID.",
    parameters: { name: requiredString, parentFolderId: string },
  },
  {
    name: "add_tracks_to_playlist",
    description: "Add tracks to an ordinary playlist without duplicates. Supply either trackIds, or match to add all tracks matching the filters locally.",
    parameters: {
      playlistId: requiredString,
      trackIds,
      match: {
        type: "object",
        properties: { query: string, bpm: integer, sourcePlaylistId: string },
        additionalProperties: false,
      },
    },
  },
  {
    name: "update_track_field",
    description: "Set a metadata field on tracks. Title edits accept a single track.",
    parameters: {
      trackIds: { ...trackIds, required: true },
      field: { type: "string", enum: ["title", "artist", "genre", "label"], required: true },
      value: requiredString,
    },
  },
] as const;

type ToolResult =
  | { ok: true; data: JsonValue }
  | { ok: false; error: { code: string; message: string } };

function bridgeError(code: string, message: string): ToolResult {
  return { ok: false, error: { code, message } };
}

async function callRbxport(
  tool: string,
  args: object,
  signal: AbortSignal,
): Promise<ToolResult> {
  const path = process.env.RBXPORT_AGENT_PIPE;
  const token = process.env.RBXPORT_AGENT_TOKEN;
  if (!path || !token) return bridgeError("bridge_unavailable", "The rbxport desktop bridge is unavailable.");
  if (signal.aborted) return bridgeError("cancelled", "The tool call was cancelled.");

  const requestId = randomUUID();
  const socket = createConnection(path);
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  const abort = () => socket.destroy();
  socket.once("close", () => lines.close());
  lines.once("error", () => lines.close());
  signal.addEventListener("abort", abort, { once: true });
  socket.setTimeout(120_000, abort);
  try {
    socket.write(JSON.stringify({ token, requestId, tool, arguments: args }) + "\n");
    for await (const line of lines) {
      const reply = JSON.parse(line);
      if (reply.requestId === requestId && typeof reply.result?.ok === "boolean") {
        return reply.result;
      }
      break;
    }
  } catch {
    return bridgeError("bridge_unavailable", "The rbxport desktop bridge returned an invalid result.");
  } finally {
    signal.removeEventListener("abort", abort);
    lines.close();
    socket.destroy();
  }
  if (signal.aborted) return bridgeError("cancelled", "The tool call was cancelled.");
  return bridgeError("bridge_unavailable", "The rbxport desktop bridge did not return a result.");
}

export function apply(ctx: Context) {
  for (const tool of tools) {
    ctx.tools.register(defineTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      execute: (args, execution) => callRbxport(tool.name, args, execution.signal),
    }));
  }

  const modelRequests = new Map<string, number>();
  ctx.on("session/event", (session, event) => {
    if (event.type === "turn/start") modelRequests.set(session.id, 0);
    if (event.type === "turn/end") modelRequests.delete(session.id);
  });
  ctx.on("llm/stream", (options, next) => {
    const sessionId = options.sessionId;
    const count = sessionId === undefined ? undefined : modelRequests.get(sessionId);
    if (sessionId === undefined || count === undefined) return next();
    if (count >= 8) {
      throw LlmError.fromFailure({
        code: "REQUEST_LIMIT",
        message: "The 8-model-request limit for this message was reached.",
      });
    }
    modelRequests.set(sessionId, count + 1);
    return next();
  });
  ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const assembly = await next();
    assembly.contexts = assembly.contexts.filter((entry) => entry.name !== "working-directory:current");
    return assembly;
  }, { prepend: true });
}

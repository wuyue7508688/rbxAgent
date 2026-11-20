import { getBackend } from "@/ipc/client";
import { IpcError, tauriInvoke } from "@/ipc/invoke";
import { TREE_ROOT, type Backend, type RowDto, type TrackField, type TreeNode } from "@/ipc/types";
import { containerOf } from "@/lib/tree";

export interface AgentUiContext {
  source: { kind: string; name: string; playlistId: string | null };
  query: string;
  searchField: string;
  filters: unknown;
  selection: { pane: "main" | "sub" | null; tracks: { id?: string; title: string }[] };
}

export interface AgentToolUi {
  getUiContext(): AgentUiContext | Promise<AgentUiContext>;
  openPlaylist(playlistId: string): Promise<{ id: string; name: string; kind: "playlist" | "smartPlaylist" }>;
}

export type AgentToolResult = { ok: true; data: object } | { ok: false; error: { code: string; message: string } };

interface Criteria {
  query: string;
  bpm?: number;
  playlistId?: string;
}

class ToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function object(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolError("invalid_arguments", "Tool arguments must be an object.");
  }
  return input as Record<string, unknown>;
}

function string(input: unknown, field: string, allowEmpty = false): string {
  if (typeof input !== "string" || (!allowEmpty && input.trim().length === 0)) {
    throw new ToolError("invalid_arguments", `Provide a valid ${field}.`);
  }
  return input;
}

function integer(input: unknown, field: string, min: number, max: number): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < min || input > max) {
    throw new ToolError("invalid_arguments", `Provide ${field} between ${min} and ${max}.`);
  }
  return input;
}

function ids(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ToolError("invalid_arguments", "Provide at least one track ID.");
  }
  return [...new Set(input.map((id: unknown) => string(id, "track ID")))];
}

function criteria(args: Record<string, unknown>, playlistKey: "playlistId" | "sourcePlaylistId" = "playlistId"): Criteria {
  const result: Criteria = { query: args.query === undefined ? "" : string(args.query, "query", true).trim() };
  if (args.bpm !== undefined) result.bpm = integer(args.bpm, "BPM", 1, 0xffffffff);
  if (args[playlistKey] !== undefined) result.playlistId = string(args[playlistKey], "playlist ID");
  return result;
}

function isPlaylist(node: TreeNode): node is TreeNode & { kind: "playlist" | "smartPlaylist" } {
  return node.kind === "playlist" || node.kind === "smartPlaylist";
}

function playlistEntries(tree: readonly TreeNode[], query: string) {
  const folders: TreeNode[] = [];
  const items = [];
  for (const node of tree) {
    while ((folders.at(-1)?.depth ?? -1) >= node.depth) folders.pop();
    if (node.kind !== "folder" && !isPlaylist(node)) continue;
    if (node.name.toLowerCase().includes(query)) {
      items.push({ id: node.id, name: node.name, kind: node.kind,
        parentFolderId: folders.at(-1)?.id ?? null, folderPath: folders.map((folder) => folder.name) });
    }
    if (node.kind === "folder") folders.push(node);
  }
  return { items };
}

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const mockBackendEnabled = import.meta.env.MODE === "test"
  || (typeof __RBL_MOCK_BACKEND__ !== "undefined" && __RBL_MOCK_BACKEND__);

async function mockView(backend: Backend, criteria: Criteria) {
  if (criteria.playlistId && !(await backend.playlistTree()).some((node) => node.id === criteria.playlistId && isPlaylist(node))) {
    throw new ToolError("not_found", "That playlist is not in the library.");
  }
  return backend.openView({
    source: criteria.playlistId ? { kind: "playlist", id: criteria.playlistId } : { kind: "collection" },
    sort: "trackNo", descending: false, query: criteria.query,
    ...(criteria.bpm === undefined ? {} : { filter: { bpm: { values: [criteria.bpm], tolerancePct: 0, masterBpmX100: null } } }),
  });
}

async function search(args: Record<string, unknown>) {
  const match = criteria(args);
  const offset = args.offset === undefined ? 0 : integer(args.offset, "offset", 0, 0xffffffff);
  const limit = args.limit === undefined ? 20 : integer(args.limit, "limit", 1, 50);
  let total: number;
  let rows: RowDto[];
  if (!mockBackendEnabled || isTauri()) {
    ({ total, rows } = await (await tauriInvoke())<{ total: number; rows: RowDto[] }>("search_library_tracks", { criteria: match, offset, limit }));
  } else {
    const backend = await getBackend();
    const view = await mockView(backend, match);
    total = view.len;
    rows = await backend.fetchRows(view.viewId, offset, limit);
  }
  return { total, offset, nextOffset: offset + rows.length < total ? offset + rows.length : null,
    tracks: rows.map(({ id, title, artist, bpmX100, key, genre, durationSec }) =>
      ({ id, title, artist, bpm: bpmX100 / 100, key, genre, durationSec })) };
}

async function createPlaylist(backend: Backend, args: Record<string, unknown>) {
  const name = string(args.name, "playlist name").trim();
  const parent = args.parentFolderId === undefined ? TREE_ROOT : string(args.parentFolderId, "parent folder ID");
  const tree = await backend.playlistTree();
  if (parent !== TREE_ROOT && !tree.some((node) => node.id === parent && node.kind === "folder")) {
    throw new ToolError("not_found", "That folder is not in the library.");
  }
  let playlistId: string;
  if (!mockBackendEnabled || isTauri()) {
    ({ playlistId } = await (await tauriInvoke())<{ playlistId: string }>("create_playlist_with_id", { name, parent }));
  } else {
    const previousIds = new Set(tree.map((node) => node.id));
    await backend.edits.createPlaylist(name, parent);
    const updated = await backend.playlistTree();
    const created = updated.find((node) => node.kind === "playlist" && node.name === name &&
      !previousIds.has(node.id) && containerOf(updated, node) === parent);
    if (!created) throw new ToolError("backend_error", "The new playlist could not be identified.");
    playlistId = created.id;
  }
  return { playlistId, name, parentFolderId: parent === TREE_ROOT ? null : parent };
}

async function addTracks(backend: Backend, args: Record<string, unknown>) {
  const playlistId = string(args.playlistId, "playlist ID");
  if ((args.trackIds === undefined) === (args.match === undefined)) {
    throw new ToolError("invalid_arguments", "Provide either track IDs or matching criteria.");
  }
  if (!(await backend.playlistTree()).some((node) => node.id === playlistId && node.kind === "playlist")) {
    throw new ToolError("not_found", "Choose a regular playlist in the library.");
  }
  if (args.match !== undefined) {
    const match = criteria(object(args.match), "sourcePlaylistId");
    if (!mockBackendEnabled || isTauri()) {
      const result = await (await tauriInvoke())<{ requestedCount: number; added: number }>("add_matching_tracks_to_playlist", { playlist: playlistId, criteria: match });
      return { playlistId, ...result };
    }
    const view = await mockView(backend, match);
    const tracks = view.len === 0 ? [] : [...new Set(await backend.viewIdsInRange(view.viewId, 0, view.len - 1))];
    const added = tracks.length === 0 ? 0 : (await backend.edits.addTracksToPlaylist(playlistId, tracks, false)).added;
    return { playlistId, requestedCount: tracks.length, added };
  }
  const trackIds = ids(args.trackIds);
  const { added } = await backend.edits.addTracksToPlaylist(playlistId, trackIds, false);
  return { playlistId, requestedCount: trackIds.length, added };
}

function trackField(input: unknown): TrackField {
  if (input === "title" || input === "artist" || input === "genre" || input === "label") return input;
  throw new ToolError("invalid_arguments", "Choose title, artist, genre, or label.");
}

async function dispatch(tool: string, args: Record<string, unknown>, ui: AgentToolUi): Promise<object> {
  switch (tool) {
    case "get_ui_context": return ui.getUiContext();
    case "search_tracks": return search(args);
    case "list_playlists": return playlistEntries(await (await getBackend()).playlistTree(),
      args.query === undefined ? "" : string(args.query, "query", true).trim().toLowerCase());
    case "get_track_details": {
      const { id, title, artist, album, genre, label, bpmX100, key, durationSec, rating, year } =
        await (await getBackend()).trackDetails(string(args.trackId, "track ID"));
      return { id, title, artist, album, genre, label, bpm: bpmX100 / 100, key, durationSec, rating, year };
    }
    case "open_playlist": {
      const playlistId = string(args.playlistId, "playlist ID");
      if (!(await (await getBackend()).playlistTree()).some((node) => node.id === playlistId && isPlaylist(node))) {
        throw new ToolError("not_found", "That playlist is not in the library.");
      }
      return ui.openPlaylist(playlistId);
    }
    case "create_playlist": return createPlaylist(await getBackend(), args);
    case "add_tracks_to_playlist": return addTracks(await getBackend(), args);
    case "update_track_field": {
      const trackIds = ids(args.trackIds);
      const field = trackField(args.field);
      const value = string(args.value, "field value", true);
      if (field === "title" && trackIds.length !== 1) {
        throw new ToolError("invalid_arguments", "A title edit applies to one track at a time.");
      }
      const { canUndo } = await (await getBackend()).edits.setTrackField(trackIds, field, value);
      return { trackIds, field, value, canUndo };
    }
    default: throw new ToolError("invalid_arguments", "That tool is not available.");
  }
}

export async function dispatchLibraryTool(tool: string, input: unknown, ui: AgentToolUi): Promise<AgentToolResult> {
  try {
    return { ok: true, data: await dispatch(tool, object(input), ui) };
  } catch (cause) {
    if (cause instanceof ToolError) return { ok: false, error: { code: cause.code, message: cause.message } };
    if (cause instanceof IpcError && cause.kind === "notFound") {
      return { ok: false, error: { code: "not_found", message: "The requested library item could not be found." } };
    }
    if (cause instanceof IpcError && cause.kind === "readOnly") {
      return { ok: false, error: { code: "write_refused", message: "The library is read-only." } };
    }
    return { ok: false, error: { code: "backend_error", message: "rbxport could not complete the library operation." } };
  }
}

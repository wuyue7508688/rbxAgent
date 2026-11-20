import { afterEach, expect, it } from "vitest";

import { createMockBackend } from "@/ipc/backend-mock";
import { __setBackend } from "@/ipc/client";
import { TREE_ROOT } from "@/ipc/types";
import { dispatchLibraryTool, type AgentToolUi } from "./tools";

const context = {
  source: { kind: "collection", name: "All Tracks", playlistId: null },
  query: "", searchField: "all", filters: null,
  selection: { pane: "main", tracks: [{ id: "100000", title: "Selected track" }] },
} satisfies ReturnType<AgentToolUi["getUiContext"]>;

const ui: AgentToolUi = {
  getUiContext: () => context,
  openPlaylist: (id) => Promise.resolve({ id, kind: "playlist", name: "Warmup" }),
};

afterEach(() => __setBackend(null));

it("opens an actual playlist, resolves folder paths, and edits a selected track", async () => {
  const backend = createMockBackend({ trackCount: 4 });
  __setBackend(backend);
  await backend.edits.createFolder("Gigs", TREE_ROOT);
  const folder = (await backend.playlistTree()).find((node) => node.name === "Gigs");
  const created = await dispatchLibraryTool("create_playlist", { name: "Warmup", parentFolderId: folder?.id }, ui);
  if (!created.ok) throw new Error(created.error.message);
  const { playlistId } = created.data as { playlistId: string };
  expect(await dispatchLibraryTool("list_playlists", { query: "warmup" }, ui)).toEqual({
    ok: true, data: { items: [{ id: playlistId, name: "Warmup", kind: "playlist", parentFolderId: folder?.id, folderPath: ["Gigs"] }] },
  });
  expect(await dispatchLibraryTool("open_playlist", { playlistId }, ui)).toEqual({
    ok: true, data: { id: playlistId, kind: "playlist", name: "Warmup" },
  });
  expect(await dispatchLibraryTool("get_ui_context", {}, ui)).toEqual({ ok: true, data: context });
  expect(await dispatchLibraryTool("update_track_field", { trackIds: ["100000"], field: "genre", value: "House" }, ui)).toMatchObject({ ok: true });
  const details = await dispatchLibraryTool("get_track_details", { trackId: "100000" }, ui);
  expect(details).toMatchObject({ ok: true, data: { id: "100000", genre: "House" } });
  expect(details).not.toHaveProperty("data.path");
});

it("adds the full local match beyond a search page, skips duplicates, and records undo", async () => {
  const backend = createMockBackend({ trackCount: 80 });
  __setBackend(backend);
  const created = await dispatchLibraryTool("create_playlist", { name: "Agent result" }, ui);
  if (!created.ok) throw new Error(created.error.message);
  const { playlistId } = created.data as { playlistId: string };
  const search = await dispatchLibraryTool("search_tracks", {}, ui);
  expect(search).toMatchObject({ ok: true, data: { total: 80, offset: 0, nextOffset: 20 } });
  expect(await dispatchLibraryTool("add_tracks_to_playlist", { playlistId, match: {} }, ui)).toEqual({
    ok: true, data: { playlistId, requestedCount: 80, added: 80 },
  });
  expect(await dispatchLibraryTool("add_tracks_to_playlist", { playlistId, trackIds: ["100000", "100000"] }, ui)).toEqual({
    ok: true, data: { playlistId, requestedCount: 1, added: 0 },
  });
  expect(await dispatchLibraryTool("search_tracks", { playlistId, offset: 75 }, ui)).toMatchObject({
    ok: true, data: { total: 80, offset: 75, nextOffset: null },
  });
  await backend.edits.undoEdit();
  expect(await dispatchLibraryTool("search_tracks", { playlistId }, ui)).toMatchObject({ ok: true, data: { total: 0 } });
});

it("rejects invalid arguments before running a write", async () => {
  expect(await dispatchLibraryTool("add_tracks_to_playlist", { playlistId: "1", trackIds: ["2"], match: {} }, ui)).toMatchObject({
    ok: false, error: { code: "invalid_arguments" },
  });
  expect(await dispatchLibraryTool("search_tracks", { bpm: 125.5 }, ui)).toMatchObject({
    ok: false, error: { code: "invalid_arguments" },
  });
});

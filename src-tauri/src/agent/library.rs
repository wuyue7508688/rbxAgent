use std::collections::HashSet;
use std::sync::Arc;

use parking_lot::Mutex;
use rbl_index::{BpmFilter, Library, SortColumn, TrackFilter, TrackSource, View, ViewSpec};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::{add_tracks_to_playlist, blocking, recorded_edit_with, Touched};
use crate::dto::RowDto;
use crate::error::{AppError, AppResult, ErrorKind};
use crate::state::{rows_to_dto, AppState, LibraryEdit};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrackMatch {
    query: Option<String>,
    bpm: Option<u32>,
    playlist_id: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct SearchPage {
    total: usize,
    rows: Vec<RowDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreatedPlaylist {
    playlist_id: String,
    generation: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MatchedAddition {
    requested_count: usize,
    added: usize,
}

fn playlist_source(library: &Library, playlist: &str) -> AppResult<TrackSource> {
    let playlists = library.playlists();
    let index = playlist
        .parse::<u64>()
        .ok()
        .and_then(|id| playlists.index_of(id))
        .filter(|&index| !playlists.is_folder(index))
        .ok_or_else(|| {
            AppError::new(ErrorKind::NotFound, "That playlist is not in the library.")
        })?;
    Ok(if playlists.is_smart(index) {
        TrackSource::SmartPlaylist(index)
    } else {
        TrackSource::Playlist(index)
    })
}

fn matching_view(library: &Library, criteria: TrackMatch) -> AppResult<View> {
    if criteria.bpm == Some(0) {
        return Err(AppError::new(ErrorKind::Malformed, "BPM must be positive."));
    }
    let source = criteria
        .playlist_id
        .as_deref()
        .map_or(Ok(TrackSource::Collection), |id| {
            playlist_source(library, id)
        })?;
    let filter = TrackFilter {
        bpm: criteria.bpm.map(|bpm| BpmFilter {
            values: vec![bpm],
            tolerance_pct: 0,
            master_bpm_x100: None,
        }),
        ..TrackFilter::default()
    };
    Ok(library.open_view(&ViewSpec {
        source,
        sort: SortColumn::TrackNo,
        descending: false,
        query: criteria.query.unwrap_or_default(),
        filter,
    }))
}

#[tauri::command]
pub(crate) async fn search_library_tracks(
    state: State<'_, Arc<AppState>>,
    criteria: TrackMatch,
    offset: u32,
    limit: u32,
) -> AppResult<SearchPage> {
    if !(1..=50).contains(&limit) {
        return Err(AppError::new(
            ErrorKind::Malformed,
            "Search pages must contain 1–50 tracks.",
        ));
    }
    let library = state.library()?;
    blocking("search_library_tracks", move || {
        let view = matching_view(&library, criteria)?;
        let offset = offset as usize;
        Ok(SearchPage {
            total: view.len(),
            rows: rows_to_dto(&library, view.window(offset, limit as usize), offset),
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn create_playlist_with_id<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, Arc<AppState>>,
    name: String,
    parent: String,
) -> AppResult<CreatedPlaylist> {
    let id = Arc::new(Mutex::new(String::new()));
    let result_id = Arc::clone(&id);
    let history = recorded_edit_with(
        app,
        state,
        "create_playlist_with_id",
        Touched::Playlists,
        move |writer| {
            writer.create_with_undo(&name, &parent, rbl_db::write::ATTRIBUTE_PLAYLIST, None)
        },
        move |history, (playlist_id, edit)| {
            *result_id.lock() = playlist_id;
            history.record(LibraryEdit::CreatePlaylist(edit), "Create Playlist");
        },
    )
    .await?;
    let playlist_id = std::mem::take(&mut *id.lock());
    Ok(CreatedPlaylist {
        playlist_id,
        generation: history.generation,
    })
}

#[tauri::command]
pub(crate) async fn add_matching_tracks_to_playlist<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, Arc<AppState>>,
    playlist: String,
    criteria: TrackMatch,
) -> AppResult<MatchedAddition> {
    let library = state.library()?;
    if !matches!(
        playlist_source(&library, &playlist)?,
        TrackSource::Playlist(_)
    ) {
        return Err(AppError::new(
            ErrorKind::Malformed,
            "Choose a regular playlist to add tracks.",
        ));
    }
    let tracks = blocking("match_playlist_addition", move || {
        let view = matching_view(&library, criteria)?;
        let mut seen = HashSet::new();
        Ok(view
            .rows
            .iter()
            .filter_map(|&row| library.ids.get(row as usize))
            .filter(|&&id| seen.insert(id))
            .map(u64::to_string)
            .collect::<Vec<_>>())
    })
    .await?;
    let requested_count = tracks.len();
    let added = if tracks.is_empty() {
        0
    } else {
        add_tracks_to_playlist(app, state, playlist, tracks, Some(false), None)
            .await?
            .added
    };
    Ok(MatchedAddition {
        requested_count,
        added,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use rbl_db::fixture::{self, Shape};
    use rbl_db::{Library as Db, OpenMode};
    use tauri::Manager;

    #[test]
    fn match_uses_the_browser_bpm_bucket_and_adds_beyond_the_page() {
        let temporary = tempfile::tempdir().unwrap();
        let location = fixture::build(temporary.path(), Shape::default()).unwrap();
        fixture::set_tempo(&location, 0, 12_900).unwrap();
        let db = Db::open(location.clone(), OpenMode::ReadOnly).unwrap();
        let (library, _) = rbl_index::load(&db).unwrap();
        let state = AppState::with_backups(temporary.path().join("backups"));
        state.set_library(library, false, db.schema().db_version, 0, location);
        drop(db);
        let app = tauri::test::mock_app();
        app.manage(Arc::new(state));
        tauri::async_runtime::block_on(async {
            let handle = app.handle();
            let state = || app.state::<Arc<AppState>>();
            let criteria = || TrackMatch {
                query: None,
                bpm: Some(128),
                playlist_id: None,
            };
            let page = search_library_tracks(state(), criteria(), 0, 20)
                .await
                .unwrap();
            assert_eq!(page.total, 39);
            assert_eq!(page.rows.len(), 20);
            let made = create_playlist_with_id(
                handle.clone(),
                state(),
                "Warmup".to_owned(),
                "root".to_owned(),
            )
            .await
            .unwrap();
            let playlist_id = &made.playlist_id;
            let added = add_matching_tracks_to_playlist(
                handle.clone(),
                state(),
                playlist_id.clone(),
                criteria(),
            )
            .await
            .unwrap();
            assert_eq!((added.requested_count, added.added), (39, 39));
            let duplicate = add_matching_tracks_to_playlist(
                handle.clone(),
                state(),
                playlist_id.clone(),
                criteria(),
            )
            .await
            .unwrap();
            assert_eq!((duplicate.requested_count, duplicate.added), (39, 0));
            let playlist = || TrackMatch {
                query: None,
                bpm: None,
                playlist_id: Some(playlist_id.clone()),
            };
            let later = search_library_tracks(state(), playlist(), 20, 20)
                .await
                .unwrap();
            assert_eq!((later.total, later.rows.len()), (39, 19));
            crate::commands::undo_edit(handle.clone(), state())
                .await
                .unwrap();
            let empty = search_library_tracks(state(), playlist(), 0, 20)
                .await
                .unwrap();
            assert_eq!(empty.total, 0);
        });
    }
}

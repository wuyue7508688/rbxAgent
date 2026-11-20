pub(crate) mod library;
#[cfg(windows)]
mod windows;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

#[cfg(windows)]
pub(crate) use windows::Agent;
#[cfg(not(windows))]
#[derive(Default)]
pub(crate) struct Agent {}

#[derive(Serialize)]
pub(crate) struct RunResult {
    text: String,
}

#[tauri::command]
pub(crate) fn agent_configure(
    state: State<'_, Agent>,
    provider: String,
    model: String,
    api_key: String,
) -> Result<(), String> {
    #[cfg(windows)]
    return state.configure(&provider, &model, &api_key);
    #[cfg(not(windows))]
    {
        let _ = (state, provider, model, api_key);
        Err("The library Agent requires Windows.".into())
    }
}

#[tauri::command]
pub(crate) fn agent_has_key(provider: String) -> bool {
    #[cfg(windows)]
    return windows::has_key(&provider);
    #[cfg(not(windows))]
    {
        let _ = provider;
        false
    }
}

#[tauri::command]
pub(crate) async fn agent_run(
    app: AppHandle,
    state: State<'_, Agent>,
    session_id: String,
    provider: String,
    model: String,
    text: String,
) -> Result<RunResult, String> {
    #[cfg(windows)]
    return windows::run(&app, &state, &session_id, &provider, &model, &text).await;
    #[cfg(not(windows))]
    {
        let _ = (app, state, session_id, provider, model, text);
        Err("The library Agent requires Windows.".into())
    }
}

#[tauri::command]
pub(crate) async fn agent_test(
    app: AppHandle,
    state: State<'_, Agent>,
    provider: String,
    model: String,
) -> Result<(), String> {
    #[cfg(windows)]
    return windows::test(&app, &state, &provider, &model).await;
    #[cfg(not(windows))]
    {
        let _ = (app, state, provider, model);
        Err("The library Agent requires Windows.".into())
    }
}

#[tauri::command]
pub(crate) fn agent_stop(state: State<'_, Agent>) {
    #[cfg(windows)]
    state.stop();
    #[cfg(not(windows))]
    let _ = state;
}

#[tauri::command]
pub(crate) async fn agent_delete_session(
    app: AppHandle,
    state: State<'_, Agent>,
    session_id: String,
) -> Result<(), String> {
    #[cfg(windows)]
    return windows::delete_session(&app, &state, &session_id).await;
    #[cfg(not(windows))]
    {
        let _ = (app, state, session_id);
        Err("The library Agent requires Windows.".into())
    }
}

#[tauri::command]
pub(crate) fn agent_tool_result(
    state: State<'_, Agent>,
    request_id: String,
    result: Value,
) -> Result<(), String> {
    #[cfg(windows)]
    return state.tool_result(&request_id, result);
    #[cfg(not(windows))]
    {
        let _ = (state, request_id, result);
        Err("The library Agent requires Windows.".into())
    }
}

pub(crate) fn stop_on_exit(app: &AppHandle) {
    #[cfg(windows)]
    {
        use tauri::Manager as _;
        app.state::<Agent>().close();
    }
    #[cfg(not(windows))]
    let _ = app;
}

#![allow(unsafe_code)]

use super::Pending;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io,
    os::windows::io::{AsRawHandle as _, FromRawHandle as _, OwnedHandle},
    ptr,
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Emitter as _};
use tokio::{
    io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader},
    net::windows::named_pipe::{NamedPipeServer, ServerOptions},
    process::Child,
    sync::{oneshot, Mutex},
    task::JoinSet,
    time::timeout,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub(super) struct Job(OwnedHandle);

impl Job {
    pub(super) fn new() -> io::Result<Self> {
        let raw = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let size = u32::try_from(std::mem::size_of_val(&limits)).map_err(io::Error::other)?;
        let configured = unsafe {
            SetInformationJobObject(
                handle.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                size,
            )
        };
        if configured == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(handle))
    }

    pub(super) fn attach(&self, child: &Child) -> io::Result<()> {
        let process = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("Agent process is unavailable"))?;
        if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), process) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

pub(super) fn listen(name: &str, first: bool) -> io::Result<NamedPipeServer> {
    ServerOptions::new()
        .first_pipe_instance(first)
        .reject_remote_clients(true)
        .create(name)
}

pub(super) async fn serve(
    mut listener: NamedPipeServer,
    name: String,
    token: String,
    app: AppHandle,
    pending: Pending,
    enabled: bool,
) {
    let mut connections = JoinSet::new();
    let token: Arc<str> = token.into();
    let serial = Arc::new(Mutex::new(()));
    loop {
        tokio::select! {
            _ = connections.join_next(), if !connections.is_empty() => {}
            connected = listener.connect() => {
                if connected.is_err() {
                    break;
                }
                let Ok(next) = listen(&name, false) else { break };
                let connected = std::mem::replace(&mut listener, next);
                let token = Arc::clone(&token);
                let app = app.clone();
                let pending = Arc::clone(&pending);
                let serial = Arc::clone(&serial);
                connections.spawn(async move {
                    let _ = handle(connected, &token, &app, &pending, &serial, enabled).await;
                });
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    token: String,
    request_id: String,
    tool: String,
    arguments: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolCall<'a> {
    request_id: &'a str,
    tool: &'a str,
    arguments: &'a Value,
}

struct Registration<'a> {
    pending: &'a Pending,
    id: &'a str,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.pending.lock().remove(self.id);
    }
}

async fn handle(
    pipe: NamedPipeServer,
    token: &str,
    app: &AppHandle,
    pending: &Pending,
    serial: &Mutex<()>,
    enabled: bool,
) -> io::Result<()> {
    let mut socket = BufReader::new(pipe);
    let mut frame = Vec::new();
    timeout(
        Duration::from_secs(5),
        (&mut socket).take(1_048_576).read_until(b'\n', &mut frame),
    )
    .await??;
    if frame.last() != Some(&b'\n') {
        return Ok(());
    }
    let request: Request = serde_json::from_slice(&frame)?;
    if request.token != token || super::session_id(&request.request_id).is_err() {
        return Ok(());
    }
    let result = if enabled
        && matches!(
            request.tool.as_str(),
            "get_ui_context"
                | "search_tracks"
                | "list_playlists"
                | "get_track_details"
                | "open_playlist"
                | "create_playlist"
                | "add_tracks_to_playlist"
                | "update_track_field"
        ) {
        let _permit = serial.lock().await;
        dispatch(app, pending, &request).await
    } else {
        json!({ "ok": false, "error": { "code": "unknown_tool", "message": "This tool is unavailable." } })
    };
    let reply = json!({ "requestId": request.request_id, "result": result });
    socket
        .get_mut()
        .write_all(format!("{reply}\n").as_bytes())
        .await
}

async fn dispatch(app: &AppHandle, pending: &Pending, request: &Request) -> Value {
    let (send, receive) = oneshot::channel();
    {
        let mut queue = pending.lock();
        if queue.contains_key(&request.request_id) {
            return json!({ "ok": false, "error": { "code": "duplicate_call", "message": "This tool request is already active." } });
        }
        queue.insert(request.request_id.clone(), send);
    }
    let _registration = Registration {
        pending,
        id: &request.request_id,
    };
    let event = ToolCall {
        request_id: &request.request_id,
        tool: &request.tool,
        arguments: &request.arguments,
    };
    if app.emit_to("main", "agent:tool", event).is_ok() {
        if let Ok(Ok(value)) = timeout(Duration::from_secs(180), receive).await {
            return value;
        }
    }
    json!({ "ok": false, "error": { "code": "tool_unavailable", "message": "The library tool did not finish." } })
}

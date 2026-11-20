use super::RunResult;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager as _};
use tokio::{
    io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{oneshot, Mutex as AsyncMutex},
    time::timeout,
};
use uuid::Uuid;

mod credentials;
mod pipe;

const TURN_TIMEOUT: Duration = Duration::from_secs(600);
const START_TIMEOUT: Duration = Duration::from_secs(30);

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

#[derive(Default)]
pub(crate) struct Agent {
    active: Mutex<Option<Active>>,
    runtime: AsyncMutex<Option<Runtime>>,
    pending: Pending,
    credential_revision: AtomicU64,
}

struct Active {
    stop: Option<oneshot::Sender<()>>,
}

struct Lease<'a>(&'a Agent);

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        *self.0.active.lock() = None;
    }
}

impl Agent {
    fn reserve(&self) -> Result<(Lease<'_>, oneshot::Receiver<()>), String> {
        let mut active = self.active.lock();
        if active.is_some() {
            return Err("The library Agent is already running.".into());
        }
        let (stop, stopped) = oneshot::channel();
        *active = Some(Active { stop: Some(stop) });
        Ok((Lease(self), stopped))
    }

    pub(super) fn configure(&self, provider: &str, model: &str, key: &str) -> Result<(), String> {
        let route = Route::new(provider, model)?;
        credentials::save(route.provider, key.trim())?;
        self.credential_revision.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    pub(super) fn stop(&self) {
        if let Some(stop) = self
            .active
            .lock()
            .as_mut()
            .and_then(|active| active.stop.take())
        {
            let _ = stop.send(());
        }
    }

    pub(super) fn close(&self) {
        self.stop();
        tauri::async_runtime::block_on(async {
            if let Ok(mut slot) = timeout(Duration::from_secs(6), self.runtime.lock()).await {
                if let Some(mut runtime) = slot.take() {
                    runtime.shutdown().await;
                }
            }
        });
    }

    pub(super) fn tool_result(&self, request_id: &str, result: Value) -> Result<(), String> {
        let sender = self
            .pending
            .lock()
            .remove(request_id)
            .ok_or_else(|| "The tool request is no longer active.".to_owned())?;
        sender
            .send(result)
            .map_err(|_| "The tool request is no longer active.".into())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Provider {
    DeepSeek,
    OpenAi,
}

impl Provider {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "deepseek" => Ok(Self::DeepSeek),
            "openai" => Ok(Self::OpenAi),
            _ => Err("Unknown model provider.".into()),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::DeepSeek => "deepseek",
            Self::OpenAi => "openai",
        }
    }

    fn key_name(self) -> &'static str {
        match self {
            Self::DeepSeek => "DEEPSEEK_API_KEY",
            Self::OpenAi => "OPENAI_API_KEY",
        }
    }
}

#[derive(PartialEq, Eq)]
struct Route {
    provider: Provider,
    model: String,
}

impl Route {
    fn new(provider: &str, model: &str) -> Result<Self, String> {
        let model = model.trim();
        if model.is_empty() || model.len() > 128 || model.chars().any(char::is_control) {
            return Err("Enter a valid model ID.".into());
        }
        Ok(Self {
            provider: Provider::parse(provider)?,
            model: model.into(),
        })
    }
}

pub(super) fn has_key(provider: &str) -> bool {
    Provider::parse(provider).is_ok_and(|provider| credentials::load(provider).is_ok())
}

fn home(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions)
        && std::env::var_os("RBXPORT_TEST").as_deref() == Some(std::ffi::OsStr::new("1"))
    {
        if let Some(state) =
            std::env::var_os(rbl_backup::STATE_DIR_ENV).filter(|value| !value.is_empty())
        {
            return Ok(PathBuf::from(state).join("agent"));
        }
    }
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("agent"))
        .map_err(|_| "The library Agent data directory is unavailable.".into())
}

fn session_id(value: &str) -> Result<&str, String> {
    if Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value) {
        return Ok(value);
    }
    Err("Invalid conversation ID.".into())
}

fn stored_session(home: &Path, id: &str) -> Result<Option<PathBuf>, String> {
    let groups = match std::fs::read_dir(home.join("sessions")) {
        Ok(groups) => groups,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Could not read saved conversations.".into()),
    };
    let mut found = None;
    for group in groups {
        let group = group.map_err(|_| "Could not read saved conversations.")?;
        if !group
            .file_type()
            .map_err(|_| "Could not read the conversation directory.")?
            .is_dir()
        {
            continue;
        }
        let path = group.path().join(id);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("Could not read the conversation directory.".into()),
        };
        if !metadata.file_type().is_dir() || found.is_some() {
            return Err("The saved conversation directory is ambiguous.".into());
        }
        found = Some(path);
    }
    Ok(found)
}

pub(super) async fn delete_session(app: &AppHandle, state: &Agent, id: &str) -> Result<(), String> {
    let id = session_id(id)?;
    let (_lease, _) = state.reserve()?;
    if let Some(mut runtime) = state.runtime.lock().await.take() {
        runtime.shutdown().await;
    }
    let root = home(app)?;
    if let Some(path) = stored_session(&root, id)? {
        let sessions = std::fs::canonicalize(root.join("sessions"))
            .map_err(|_| "Could not locate the conversation store.")?;
        let path =
            std::fs::canonicalize(path).map_err(|_| "Could not locate the saved conversation.")?;
        if !path.strip_prefix(sessions).is_ok_and(|relative| {
            relative.components().count() == 2
                && relative.file_name() == Some(std::ffi::OsStr::new(id))
        }) {
            return Err("The saved conversation is outside the conversation store.".into());
        }
        tokio::task::spawn_blocking(move || std::fs::remove_dir_all(path))
            .await
            .map_err(|_| "Could not delete the conversation.")?
            .map_err(|_| "Could not delete the conversation.")?;
    }
    Ok(())
}

pub(super) async fn run(
    app: &AppHandle,
    state: &Agent,
    id: &str,
    provider: &str,
    model: &str,
    text: &str,
) -> Result<RunResult, String> {
    let id = session_id(id)?;
    let route = Route::new(provider, model)?;
    let text = text.trim();
    if text.is_empty() {
        return Err("Enter a message for the library Agent.".into());
    }
    let (_lease, mut stopped) = state.reserve()?;
    let mut slot = state.runtime.lock().await;
    let root = home(app)?;
    let revision = state.credential_revision.load(Ordering::Relaxed);
    let mut runtime = slot.take();
    let result = tokio::select! {
        () = async { let _ = (&mut stopped).await; } => Err("The library Agent was stopped.".into()),
        result = timeout(TURN_TIMEOUT, async {
            if runtime.as_ref().is_some_and(|running| running.route != route || running.revision != revision) {
                if let Some(mut old) = runtime.take() {
                    old.shutdown().await;
                }
            }
            if runtime.is_none() {
                runtime = Some(Runtime::start(app, state, &root, route, revision, true).await?);
            }
            let running = runtime.as_mut().ok_or("The library Agent could not start.")?;
            running.turn(&root, id, text).await
        }) => result.map_err(|_| "The library Agent timed out.".to_owned()).and_then(|result| result),
    };
    if result.is_ok() {
        *slot = runtime;
    } else if let Some(mut runtime) = runtime {
        runtime.pipe.abort();
        runtime.shutdown().await;
    }
    result.map(|text| RunResult { text })
}

pub(super) async fn test(
    app: &AppHandle,
    state: &Agent,
    provider: &str,
    model: &str,
) -> Result<(), String> {
    let route = Route::new(provider, model)?;
    let (_lease, mut stopped) = state.reserve()?;
    let temp =
        tempfile::tempdir().map_err(|_| "Could not create the connection test directory.")?;
    let id = Uuid::new_v4().to_string();
    tokio::select! {
        () = async { let _ = (&mut stopped).await; } => Err("The connection test was stopped.".into()),
        result = timeout(Duration::from_secs(60), async {
            let mut runtime = Runtime::start(app, state, temp.path(), route, 0, false).await?;
            let result = runtime.turn(temp.path(), &id, "Reply with OK to test this model connection.").await;
            runtime.shutdown().await;
            result.map(|_| ())
        }) => result.map_err(|_| "The model connection timed out.".to_owned()).and_then(|result| result),
    }
}

struct Runtime {
    route: Route,
    revision: u64,
    child: Child,
    _job: pipe::Job,
    pipe: tokio::task::JoinHandle<()>,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    open_sessions: HashSet<String>,
    request_id: u64,
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.pipe.abort();
        let _ = self.child.start_kill();
    }
}

impl Runtime {
    async fn start(
        app: &AppHandle,
        state: &Agent,
        root: &Path,
        route: Route,
        revision: u64,
        tools_enabled: bool,
    ) -> Result<Self, String> {
        let bundled = app
            .path()
            .resource_dir()
            .ok()
            .map(|path| path.join("agent/dsh"));
        let assets = bundled
            .filter(|path| path.join("rbxport.patch.yml").is_file())
            .or_else(|| {
                cfg!(debug_assertions)
                    .then(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../agent/dsh"))
            })
            .ok_or("The bundled library Agent runtime is missing.")?;
        let assets = dunce::simplified(&assets);
        let bundled_node = std::env::current_exe()
            .ok()
            .map(|path| path.with_file_name("rbxport-agent-node.exe"));
        let node = bundled_node
            .filter(|path| path.is_file())
            .or_else(|| cfg!(debug_assertions).then(|| PathBuf::from("node.exe")))
            .ok_or("The bundled Node.js runtime is missing.")?;
        let entry = assets.join("node_modules/@deepseek-ai/dsh/lib/bin.js");
        if !entry.is_file() {
            return Err("The library Agent runtime has not been prepared.".into());
        }
        let key = credentials::load(route.provider)?;
        let cwd = root.join("workspace");
        std::fs::create_dir_all(&cwd)
            .map_err(|_| "Could not create the library Agent directory.")?;
        let pipe_name = format!(r"\\.\pipe\rbxport-agent-{}", Uuid::new_v4());
        let token = Uuid::new_v4().to_string();
        let listener = pipe::listen(&pipe_name, true)
            .map_err(|_| "Could not open the local library tool bridge.")?;
        let job = pipe::Job::new().map_err(|_| "Could not prepare the library Agent process.")?;
        let mut child = Command::new(node)
            .arg(entry)
            .args(["--profile", "sdk-minimal", "--patch"])
            .arg(assets.join("rbxport.patch.yml"))
            .current_dir(&cwd)
            .env("DSH_HOME", root)
            .env_remove("OPENAI_API_KEY")
            .env_remove("DEEPSEEK_API_KEY")
            .env(route.provider.key_name(), key)
            .env("RBXPORT_AGENT_MODEL", &route.model)
            .env("RBXPORT_AGENT_PIPE", &pipe_name)
            .env("RBXPORT_AGENT_TOKEN", &token)
            .creation_flags(0x0800_0000)
            .kill_on_drop(true)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|_| "Could not start the library Agent process.")?;
        job.attach(&child)
            .map_err(|_| "Could not bind the library Agent to the application lifecycle.")?;
        let stdin = child
            .stdin
            .take()
            .ok_or("The Agent input stream is unavailable.")?;
        let stdout = BufReader::new(
            child
                .stdout
                .take()
                .ok_or("The Agent output stream is unavailable.")?,
        );
        let pipe = tokio::spawn(pipe::serve(
            listener,
            pipe_name,
            token,
            app.clone(),
            Arc::clone(&state.pending),
            tools_enabled,
        ));
        let mut runtime = Self {
            route,
            revision,
            child,
            _job: job,
            pipe,
            stdin,
            stdout,
            open_sessions: HashSet::new(),
            request_id: 0,
        };
        let params = json!({ "cwd": cwd, "provider": runtime.route.provider.id(), "model": runtime.route.model });
        let mut turn = Turn::default();
        timeout(
            START_TIMEOUT,
            runtime.request("initialize", params, "", &mut turn),
        )
        .await
        .map_err(|_| "The library Agent did not start in time.")??;
        Ok(runtime)
    }

    async fn turn(&mut self, root: &Path, id: &str, text: &str) -> Result<String, String> {
        if !self.open_sessions.contains(id) && stored_session(root, id)?.is_some() {
            self.request(
                "session/resume",
                json!({ "sessionId": id }),
                "",
                &mut Turn::default(),
            )
            .await?;
        }
        let mut turn = Turn::default();
        self.request(
            "session/prompt",
            json!({
                "sessionId": id,
                "contentBlocks": [{ "type": "text", "text": text }],
            }),
            id,
            &mut turn,
        )
        .await?;
        self.open_sessions.insert(id.into());
        self.request("session/wait", json!({ "sessionId": id }), id, &mut turn)
            .await?;
        turn.finish()
    }

    async fn shutdown(&mut self) {
        let _ = timeout(Duration::from_secs(5), async {
            self.request("shutdown", json!({}), "", &mut Turn::default())
                .await?;
            self.stdin
                .shutdown()
                .await
                .map_err(|_| "Could not close the library Agent input stream.")?;
            self.child
                .wait()
                .await
                .map_err(|_| "Could not wait for the library Agent to exit.")?;
            Ok::<(), String>(())
        })
        .await;
    }

    async fn request(
        &mut self,
        method: &str,
        params: Value,
        session: &str,
        turn: &mut Turn,
    ) -> Result<(), String> {
        self.request_id += 1;
        let message =
            json!({ "jsonrpc": "2.0", "id": self.request_id, "method": method, "params": params });
        self.stdin
            .write_all(format!("{message}\n").as_bytes())
            .await
            .map_err(|_| "The library Agent input stream closed.")?;
        let mut line = String::new();
        loop {
            line.clear();
            if self
                .stdout
                .read_line(&mut line)
                .await
                .map_err(|_| "Could not read the library Agent response.")?
                == 0
            {
                return Err("The library Agent stopped unexpectedly.".into());
            }
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if message["id"].as_u64() == Some(self.request_id) {
                if let Some(error) = message.get("error") {
                    return Err(failure(error["message"].as_str().unwrap_or_default()).into());
                }
                return Ok(());
            }
            if let Some(request_id) = message.get("id").filter(|_| message["method"].is_string()) {
                let error = json!({ "jsonrpc": "2.0", "id": request_id, "error": { "code": -32601, "message": "Unsupported host request" } });
                self.stdin
                    .write_all(format!("{error}\n").as_bytes())
                    .await
                    .map_err(|_| "The library Agent input stream closed.")?;
                continue;
            }
            let params = &message["params"];
            if message["method"] == "session.event" && params["sessionId"].as_str() == Some(session)
            {
                turn.observe(&params["event"]);
            }
        }
    }
}

#[derive(Default)]
struct Turn {
    text: String,
    error: Option<&'static str>,
}

impl Turn {
    fn observe(&mut self, event: &Value) {
        let data = &event["data"];
        match event["type"].as_str() {
            Some("assistant/message") => {
                if let Some(content) = data["message"]["content"].as_array() {
                    let text: String = content
                        .iter()
                        .filter(|block| block["type"] == "text")
                        .filter_map(|block| block["text"].as_str())
                        .collect();
                    if !text.is_empty() {
                        self.text = text;
                    }
                }
            }
            Some("turn/end") => match data["reason"]["kind"].as_str() {
                Some("error" | "aborted" | "blocked" | "max-tokens") => {
                    self.error = Some(failure(&data["reason"].to_string()))
                }
                _ => {}
            },
            _ => {}
        }
    }

    fn finish(self) -> Result<String, String> {
        if let Some(error) = self.error {
            return Err(error.into());
        }
        if self.text.trim().is_empty() {
            return Err("The model returned no answer.".into());
        }
        Ok(self.text)
    }
}

fn failure(message: &str) -> &'static str {
    let message = message.to_ascii_lowercase();
    if message.contains("request_limit") {
        "The library Agent reached its eight model request limit."
    } else if message.contains("401")
        || message.contains("unauthorized")
        || message.contains("invalid api key")
    {
        "The model provider rejected the API key."
    } else if message.contains("429")
        || message.contains("rate limit")
        || message.contains("insufficient")
        || message.contains("402")
    {
        "The model provider rate limit or account quota was reached."
    } else if message.contains("model")
        && (message.contains("unknown") || message.contains("not found"))
    {
        "The configured model is unavailable."
    } else if message.contains("network")
        || message.contains("fetch")
        || message.contains("timeout")
    {
        "Could not connect to the model provider."
    } else {
        "The library Agent could not complete the request."
    }
}

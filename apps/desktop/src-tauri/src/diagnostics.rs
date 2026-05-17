// Desktop diagnostics: structured logs, engine probes, export bundle.
// Read-only with respect to DAW state — never mutates arrangement/project.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};

use crate::native_health::{resolve_socket_path, NativeHealthSnapshot};
use crate::native_sidecar::NativeSidecarManager;

const LOG_CAP: usize = 2000;
const ENGINE_DEFAULT_PORT: u16 = 3990;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogCategory {
    Startup,
    Ipc,
    Audio,
    Plugin,
    Project,
    Transport,
    Unknown,
}

impl LogCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            LogCategory::Startup => "startup",
            LogCategory::Ipc => "ipc",
            LogCategory::Audio => "audio",
            LogCategory::Plugin => "plugin",
            LogCategory::Project => "project",
            LogCategory::Transport => "transport",
            LogCategory::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub timestamp_ms: u64,
    pub source: String,
    pub level: String,
    pub category: String,
    pub message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub online: bool,
    pub url: String,
    pub native_transport: bool,
    pub pid: Option<u64>,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFlagsSnapshot {
    pub native_clip_ops: bool,
    pub native_edit_undo: bool,
    pub native_track_ops: bool,
    pub native_project_sidecar: bool,
    pub native_legacy_sync: bool,
    pub native_transport: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDiagnostics {
    pub dashboard_online: bool,
    pub dashboard_url: String,
    pub engine: EngineStatus,
    pub native_process_running: bool,
    pub native_managed_by_desktop: bool,
    pub ipc_connected: bool,
    pub tracktion_ready: bool,
    pub audio_device_ready: bool,
    pub daw_ready: bool,
    pub socket_path: String,
    pub native_mode_enabled: bool,
    pub native_flags: NativeFlagsSnapshot,
    pub last_native_error: Option<String>,
    pub error_category: String,
    pub health: NativeHealthSnapshot,
}

#[derive(Clone)]
pub struct DiagnosticsLog {
    inner: Arc<Mutex<VecDeque<LogEntry>>>,
}

impl DiagnosticsLog {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    pub fn push(
        &self,
        source: &str,
        level: LogLevel,
        message: impl Into<String>,
    ) {
        let message = message.into();
        let category = categorize_message(&message);
        let entry = LogEntry {
            timestamp_ms: now_ms(),
            source: source.to_string(),
            level: level.as_str().to_string(),
            category: category.as_str().to_string(),
            message,
        };
        if let Ok(mut logs) = self.inner.lock() {
            logs.push_back(entry);
            while logs.len() > LOG_CAP {
                logs.pop_front();
            }
        }
    }

    pub fn push_shell_info(&self, message: impl Into<String>) {
        self.push("shell", LogLevel::Info, message);
    }

    pub fn push_shell_warn(&self, message: impl Into<String>) {
        self.push("shell", LogLevel::Warn, message);
    }

    pub fn push_shell_error(&self, message: impl Into<String>) {
        self.push("shell", LogLevel::Error, message);
    }

    pub fn push_native_stdout(&self, message: impl Into<String>) {
        let msg = message.into();
        let level = if msg.to_lowercase().contains("error") {
            LogLevel::Error
        } else if msg.to_lowercase().contains("warn") {
            LogLevel::Warn
        } else {
            LogLevel::Info
        };
        self.push("native-stdout", level, msg);
    }

    pub fn push_native_stderr(&self, message: impl Into<String>) {
        self.push("native-stderr", LogLevel::Warn, message);
    }

    pub fn entries(&self) -> Vec<LogEntry> {
        self.inner
            .lock()
            .map(|l| l.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn clear(&self) {
        if let Ok(mut logs) = self.inner.lock() {
            logs.clear();
        }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn categorize_message(message: &str) -> LogCategory {
    let lower = message.to_lowercase();
    if lower.contains("vst") || lower.contains("plugin") || lower.contains("au ") {
        return LogCategory::Plugin;
    }
    if lower.contains("transport") || lower.contains("playing") || lower.contains("seek") {
        return LogCategory::Transport;
    }
    if lower.contains(".stu") || lower.contains("project") {
        return LogCategory::Project;
    }
    if lower.contains("audio") || lower.contains("device") || lower.contains("output") {
        return LogCategory::Audio;
    }
    if lower.contains("ipc")
        || lower.contains("socket")
        || lower.contains("ping")
        || lower.contains("health.ping")
    {
        return LogCategory::Ipc;
    }
    if lower.contains("spawn")
        || lower.contains("startup")
        || lower.contains("exited")
        || lower.contains("cmake")
        || lower.contains("binary")
    {
        return LogCategory::Startup;
    }
    LogCategory::Unknown
}

pub fn derive_error_category(
    startup_error: &Option<String>,
    ipc_connected: bool,
    tracktion_ready: bool,
    audio_device_ready: bool,
    engine_online: bool,
) -> String {
    if let Some(err) = startup_error {
        let cat = categorize_message(err);
        return cat.as_str().to_string();
    }
    if !engine_online {
        return LogCategory::Startup.as_str().to_string();
    }
    if !ipc_connected {
        return LogCategory::Ipc.as_str().to_string();
    }
    if !tracktion_ready {
        return LogCategory::Startup.as_str().to_string();
    }
    if !audio_device_ready {
        return LogCategory::Audio.as_str().to_string();
    }
    LogCategory::Unknown.as_str().to_string()
}

pub fn engine_url() -> String {
    let host = std::env::var("ENGINE_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("ENGINE_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(ENGINE_DEFAULT_PORT);
    format!("http://{host}:{port}")
}

pub fn probe_engine_health() -> EngineStatus {
    let url = engine_url();
    let health_path = format!("{url}/health");

    let Some(addr) = resolve_http_addr(&url) else {
        return EngineStatus {
            online: false,
            url: health_path,
            native_transport: false,
            pid: None,
            error: Some("invalid engine URL".to_string()),
        };
    };

    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else {
        return EngineStatus {
            online: false,
            url: health_path,
            native_transport: false,
            pid: None,
            error: Some("engine not reachable".to_string()),
        };
    };

    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let host_header = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .unwrap_or(url.as_str());
    let request = format!(
        "GET /health HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return EngineStatus {
            online: false,
            url: health_path,
            native_transport: false,
            pid: None,
            error: Some("engine write failed".to_string()),
        };
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return EngineStatus {
            online: false,
            url: health_path,
            native_transport: false,
            pid: None,
            error: Some("engine read failed".to_string()),
        };
    }

    let body = response
        .split("\r\n\r\n")
        .nth(1)
        .unwrap_or("")
        .trim();
    let Ok(json) = serde_json::from_str::<Value>(body) else {
        return EngineStatus {
            online: false,
            url: health_path,
            native_transport: false,
            pid: None,
            error: Some("engine health response not JSON".to_string()),
        };
    };

    let ok = json.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let service = json
        .get("service")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let native_transport = json
        .get("nativeTransport")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let pid = json.get("pid").and_then(|v| v.as_u64());

    EngineStatus {
        online: ok && service == "thestuu-engine",
        url: health_path,
        native_transport,
        pid,
        error: if ok {
            None
        } else {
            Some("engine health ok=false".to_string())
        },
    }
}

fn resolve_http_addr(url: &str) -> Option<SocketAddr> {
    let without_scheme = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .unwrap_or(url);
    let mut addrs = without_scheme.to_socket_addrs().ok()?;
    addrs.next()
}

pub fn read_native_flags() -> NativeFlagsSnapshot {
    fn flag(name: &str) -> bool {
        match std::env::var(name) {
            Ok(v) => v == "1",
            Err(_) => false,
        }
    }
    NativeFlagsSnapshot {
        native_clip_ops: flag("STUU_NATIVE_CLIP_OPS"),
        native_edit_undo: flag("STUU_NATIVE_EDIT_UNDO"),
        native_track_ops: flag("STUU_NATIVE_TRACK_OPS"),
        native_project_sidecar: flag("STUU_NATIVE_PROJECT_SIDECAR"),
        native_legacy_sync: flag("STUU_NATIVE_LEGACY_SYNC"),
        native_transport: match std::env::var("STUU_NATIVE_TRANSPORT") {
            Ok(v) => v != "0",
            Err(_) => true,
        },
    }
}

pub fn build_diagnostics(
    manager: &NativeSidecarManager,
    dashboard_online: bool,
    dashboard_url: &str,
) -> DesktopDiagnostics {
    manager.refresh_health();
    let sidecar = manager.snapshot();
    let engine = probe_engine_health();
    let flags = read_native_flags();
    let native_mode_enabled = flags.native_transport
        || flags.native_clip_ops
        || flags.native_edit_undo
        || flags.native_track_ops;

    let ipc_connected = sidecar.health.ipc_connected;
    let tracktion_ready = sidecar.health.tracktion_ready;
    let audio_device_ready = sidecar.health.audio_device_ready;
    let daw_ready = ipc_connected && tracktion_ready && audio_device_ready;

    let last_native_error = sidecar
        .startup_error
        .clone()
        .or_else(|| sidecar.health.last_error.clone());

    let error_category = derive_error_category(
        &last_native_error,
        ipc_connected,
        tracktion_ready,
        audio_device_ready,
        engine.online,
    );

    DesktopDiagnostics {
        dashboard_online,
        dashboard_url: dashboard_url.to_string(),
        engine,
        native_process_running: sidecar.process_running,
        native_managed_by_desktop: sidecar.managed_by_desktop,
        ipc_connected,
        tracktion_ready,
        audio_device_ready,
        daw_ready,
        socket_path: sidecar.socket_path,
        native_mode_enabled,
        native_flags: flags,
        last_native_error,
        error_category,
        health: sidecar.health.clone(),
    }
}

pub fn export_bundle(
    diag: &DesktopDiagnostics,
    logs: &[LogEntry],
    app_version: &str,
) -> Value {
    json!({
        "exportedAtMs": now_ms(),
        "appVersion": app_version,
        "platform": platform_info(),
        "status": diag,
        "logs": logs,
        "socketPathDefault": resolve_socket_path(),
    })
}

fn platform_info() -> Value {
    json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "family": std::env::consts::FAMILY,
    })
}

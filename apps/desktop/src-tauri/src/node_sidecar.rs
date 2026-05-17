// Node engine process lifecycle for the Tauri desktop shell.
// Spawns/stops apps/engine (Socket.IO router) only — no DAW logic.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::diagnostics::{engine_url, probe_engine_health, DiagnosticsLog};
use crate::native_sidecar::resolve_repo_root;

const HEALTH_WAIT_MS: u64 = 25_000;
const HEALTH_POLL_MS: u64 = 150;
const ENGINE_DEFAULT_PORT: u16 = 3990;

#[derive(Clone)]
pub struct NodeSidecarManager {
    inner: Arc<Mutex<NodeSidecarState>>,
    diag_log: DiagnosticsLog,
}

struct NodeSidecarState {
    managed_by_desktop: bool,
    process_running: bool,
    startup_error: Option<String>,
    child: Option<CommandChild>,
}

impl NodeSidecarManager {
    pub fn new(diag_log: DiagnosticsLog) -> Self {
        Self {
            inner: Arc::new(Mutex::new(NodeSidecarState {
                managed_by_desktop: false,
                process_running: false,
                startup_error: None,
                child: None,
            })),
            diag_log,
        }
    }

    pub fn snapshot(&self) -> NodeSidecarSnapshot {
        let state = self.inner.lock().expect("node sidecar lock");
        NodeSidecarSnapshot {
            managed_by_desktop: state.managed_by_desktop,
            process_running: state.process_running,
            startup_error: state.startup_error.clone(),
        }
    }

    pub fn refresh_health(&self) {
        let health = probe_engine_health();
        let reachable = health.online;

        if let Ok(mut state) = self.inner.lock() {
            if reachable || state.managed_by_desktop {
                state.process_running = true;
            } else if state.child.is_none() {
                state.process_running = false;
            }
        }
    }

    /// Start after native-engine socket is available (`native_socket` for STUU_NATIVE_SOCKET).
    pub fn startup(&self, app: &AppHandle, native_socket: &str) {
        self.diag_log
            .push_shell_info(format!("node engine: {}", engine_url()));

        if probe_engine_health().online {
            self.diag_log
                .push_shell_info("existing Node engine /health ok — reusing process");
            if let Ok(mut state) = self.inner.lock() {
                state.managed_by_desktop = false;
                state.process_running = true;
                state.startup_error = None;
            }
            self.refresh_health();
            return;
        }

        match spawn_node_engine(app, native_socket) {
            Ok((log_rx, child)) => {
                if let Ok(mut state) = self.inner.lock() {
                    state.managed_by_desktop = true;
                    state.child = Some(child);
                    state.startup_error = None;
                }
                attach_log_receiver(self.clone(), log_rx);
                self.diag_log
                    .push_shell_info("spawned Node engine sidecar (apps/engine)");

                if !wait_for_engine_health(HEALTH_WAIT_MS) {
                    let msg = format!(
                        "Node engine did not respond on /health within {}s ({})",
                        HEALTH_WAIT_MS / 1000,
                        engine_url()
                    );
                    self.diag_log.push_shell_error(&msg);
                    if let Ok(mut state) = self.inner.lock() {
                        state.startup_error = Some(msg);
                        state.process_running = false;
                    }
                    return;
                }

                if let Ok(mut state) = self.inner.lock() {
                    state.process_running = true;
                }
                self.refresh_health();
            }
            Err(err) => {
                let msg = format!("failed to spawn Node engine: {err}");
                self.diag_log.push_shell_error(&msg);
                if let Ok(mut state) = self.inner.lock() {
                    state.startup_error = Some(msg);
                    state.process_running = false;
                }
            }
        }
    }

    pub fn retry_startup(&self, app: &AppHandle, native_socket: &str) {
        self.diag_log.push_shell_info("retry Node engine startup");
        self.shutdown_managed();
        if let Ok(mut state) = self.inner.lock() {
            state.startup_error = None;
        }
        self.startup(app, native_socket);
    }

    pub fn restart_startup(&self, app: &AppHandle, native_socket: &str) {
        self.diag_log.push_shell_info("restart Node engine");
        self.shutdown_managed();
        if let Ok(mut state) = self.inner.lock() {
            state.startup_error = None;
        }
        self.startup(app, native_socket);
    }

    pub fn shutdown_managed(&self) {
        let taken = {
            let mut state = match self.inner.lock() {
                Ok(s) => s,
                Err(_) => return,
            };
            if !state.managed_by_desktop {
                return;
            }
            let child = state.child.take();
            state.managed_by_desktop = false;
            state.process_running = false;
            child
        };

        let Some(command_child) = taken else {
            return;
        };

        self.diag_log
            .push_shell_info("stopping managed Node engine sidecar");
        let _ = command_child.kill();
    }
}

#[derive(Clone, serde::Serialize)]
pub struct NodeSidecarSnapshot {
    pub managed_by_desktop: bool,
    pub process_running: bool,
    pub startup_error: Option<String>,
}

fn attach_log_receiver(manager: NodeSidecarManager, mut rx: tauri::async_runtime::Receiver<CommandEvent>) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    manager
                        .diag_log
                        .push_engine_stdout(String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    manager
                        .diag_log
                        .push_engine_stderr(String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    manager.diag_log.push_shell_warn(format!(
                        "Node engine exited code={:?} signal={:?}",
                        payload.code, payload.signal
                    ));
                    if let Ok(mut state) = manager.inner.lock() {
                        if state.managed_by_desktop {
                            state.process_running = false;
                            if state.startup_error.is_none() {
                                state.startup_error =
                                    Some("Node engine process exited unexpectedly".to_string());
                            }
                        }
                    }
                    break;
                }
                CommandEvent::Error(err) => {
                    manager
                        .diag_log
                        .push_shell_error(format!("Node engine command error: {err}"));
                }
                _ => {}
            }
        }
    });
}

fn spawn_node_engine(
    app: &AppHandle,
    native_socket: &str,
) -> Result<(tauri::async_runtime::Receiver<CommandEvent>, CommandChild), String> {
    let repo_root = resolve_repo_root();
    let script = resolve_engine_script_path(&repo_root)?;
    let node_bin = resolve_node_binary();

    let host = std::env::var("ENGINE_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("ENGINE_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(ENGINE_DEFAULT_PORT);

    let stuu_home = std::env::var("STUU_HOME").unwrap_or_else(|_| {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".to_string());
        format!("{home}/.thestuu")
    });

    let (rx, child) = app
        .shell()
        .command(node_bin)
        .args([script.to_string_lossy().to_string()])
        .env("ENGINE_HOST", &host)
        .env("ENGINE_PORT", port.to_string())
        .env("STUU_NATIVE_SOCKET", native_socket)
        .env("STUU_HOME", &stuu_home)
        .env("STUU_NATIVE_TRANSPORT", "1")
        .env("STUU_NATIVE_CLIP_OPS", native_flag_env("STUU_NATIVE_CLIP_OPS", "1"))
        .env("STUU_NATIVE_EDIT_UNDO", native_flag_env("STUU_NATIVE_EDIT_UNDO", "1"))
        .env("STUU_NATIVE_TRACK_OPS", native_flag_env("STUU_NATIVE_TRACK_OPS", "1"))
        .env(
            "STUU_NATIVE_PROJECT_SIDECAR",
            native_flag_env("STUU_NATIVE_PROJECT_SIDECAR", "1"),
        )
        .env(
            "STUU_NATIVE_LEGACY_SYNC",
            native_flag_env("STUU_NATIVE_LEGACY_SYNC", "0"),
        )
        .env(
            "STUU_METER_INTERVAL_MS",
            std::env::var("STUU_METER_INTERVAL_MS").unwrap_or_else(|_| "80".to_string()),
        )
        .current_dir(&repo_root)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok((rx, child))
}

fn native_flag_env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn resolve_engine_script_path(repo_root: &std::path::Path) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("STUU_ENGINE_SCRIPT") {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Ok(candidate);
        }
        return Err(format!(
            "STUU_ENGINE_SCRIPT points to missing file: {}",
            candidate.display()
        ));
    }

    let script = repo_root.join("apps/engine/src/server.js");
    if script.is_file() {
        return Ok(script);
    }

    Err(format!(
        "Node engine entry not found at {}. Run from monorepo root or set STUU_ENGINE_SCRIPT.",
        script.display()
    ))
}

/// Command name or absolute path for `app.shell().command(...)`.
fn resolve_node_binary() -> String {
    if let Ok(path) = std::env::var("NODE") {
        let candidate = PathBuf::from(&path);
        if candidate.is_file() {
            return path;
        }
    }
    if let Ok(path) = std::env::var("STUU_NODE_BIN") {
        let candidate = PathBuf::from(&path);
        if candidate.is_file() {
            return path;
        }
    }

    let names = if cfg!(windows) {
        vec!["node.exe", "node"]
    } else {
        vec!["node"]
    };

    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            for name in &names {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return candidate.to_string_lossy().to_string();
                }
            }
        }
    }

    "node".to_string()
}

fn wait_for_engine_health(timeout_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if probe_engine_health().online {
            return true;
        }
        std::thread::sleep(Duration::from_millis(HEALTH_POLL_MS));
    }
    false
}

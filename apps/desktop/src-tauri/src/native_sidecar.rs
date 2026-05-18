// Native-engine process lifecycle for the Tauri desktop shell.
// Spawns/stops thestuu-native only — no DAW logic.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::diagnostics::DiagnosticsLog;
use crate::native_health::{probe_native_health, resolve_socket_path, socket_reachable, NativeHealthSnapshot};

const SOCKET_WAIT_MS: u64 = 25_000;
const SOCKET_POLL_MS: u64 = 120;

#[derive(Clone)]
pub struct NativeSidecarManager {
    inner: Arc<Mutex<NativeSidecarState>>,
    diag_log: DiagnosticsLog,
}

struct NativeSidecarState {
    socket_path: String,
    managed_by_desktop: bool,
    process_running: bool,
    startup_error: Option<String>,
    health: NativeHealthSnapshot,
    child: Option<ManagedChild>,
}

enum ManagedChild {
    Sidecar(CommandChild),
}

impl NativeSidecarManager {
    pub fn new(diag_log: DiagnosticsLog) -> Self {
        Self {
            inner: Arc::new(Mutex::new(NativeSidecarState {
                socket_path: resolve_socket_path(),
                managed_by_desktop: false,
                process_running: false,
                startup_error: None,
                health: NativeHealthSnapshot::default(),
                child: None,
            })),
            diag_log,
        }
    }

    pub fn diagnostics_log(&self) -> &DiagnosticsLog {
        &self.diag_log
    }

    pub fn socket_path(&self) -> String {
        self.inner.lock().map(|s| s.socket_path.clone()).unwrap_or_default()
    }

    pub fn snapshot(&self) -> SidecarSnapshot {
        let state = self.inner.lock().expect("native sidecar lock");
        SidecarSnapshot {
            socket_path: state.socket_path.clone(),
            managed_by_desktop: state.managed_by_desktop,
            process_running: state.process_running,
            startup_error: state.startup_error.clone(),
            health: state.health.clone(),
        }
    }

    pub fn refresh_health(&self) {
        let socket_path = self.socket_path();
        let health = probe_native_health(&socket_path, Duration::from_secs(2));
        let reachable = socket_reachable(&socket_path, Duration::from_millis(400));

        if let Ok(mut state) = self.inner.lock() {
            state.health = health;
            if reachable || state.managed_by_desktop {
                state.process_running = true;
            } else if state.child.is_none() {
                state.process_running = false;
            }
        }
    }

    pub fn startup(&self, app: &AppHandle) {
        let socket_path = discover_existing_socket().unwrap_or_else(resolve_socket_path);
        if let Ok(mut state) = self.inner.lock() {
            state.socket_path = socket_path.clone();
        }

        self.diag_log
            .push_shell_info(format!("native socket: {socket_path}"));

        if socket_reachable(&socket_path, Duration::from_millis(500)) {
            self.diag_log
                .push_shell_info("existing native-engine socket detected — reusing process");
            if let Ok(mut state) = self.inner.lock() {
                state.managed_by_desktop = false;
                state.process_running = true;
                state.startup_error = None;
            }
            self.refresh_health();
            return;
        }

        match spawn_native_sidecar(app, &socket_path) {
            Ok((log_rx, child)) => {
                if let Ok(mut state) = self.inner.lock() {
                    state.managed_by_desktop = true;
                    state.child = Some(ManagedChild::Sidecar(child));
                    state.startup_error = None;
                }
                attach_log_receiver(self.clone(), log_rx);
                self.diag_log.push_shell_info("spawned native-engine sidecar");

                if !wait_for_socket(&socket_path, SOCKET_WAIT_MS) {
                    let msg = format!(
                        "native-engine did not open socket within {}s: {socket_path}",
                        SOCKET_WAIT_MS / 1000
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
                let msg = format!("failed to spawn native-engine: {err}");
                self.diag_log.push_shell_error(&msg);
                if let Ok(mut state) = self.inner.lock() {
                    state.startup_error = Some(msg);
                    state.process_running = false;
                }
            }
        }
    }

    pub fn retry_startup(&self, app: &AppHandle) {
        self.diag_log.push_shell_info("retry native-engine startup");
        self.shutdown_managed();
        if let Ok(mut state) = self.inner.lock() {
            state.startup_error = None;
            state.health = NativeHealthSnapshot::default();
        }
        self.startup(app);
    }

    pub fn restart_startup(&self, app: &AppHandle) {
        self.diag_log.push_shell_info("restart native-engine");
        self.shutdown_managed();
        if let Ok(mut state) = self.inner.lock() {
            state.startup_error = None;
            state.health = NativeHealthSnapshot::default();
        }
        self.startup(app);
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
            let socket = state.socket_path.clone();
            let child = state.child.take();
            state.managed_by_desktop = false;
            state.process_running = false;
            child.map(|c| (c, socket))
        };

        let Some((ManagedChild::Sidecar(command_child), socket_path)) = taken else {
            return;
        };

        self.diag_log
            .push_shell_info("stopping managed native-engine sidecar");
        let _ = command_child.kill();

        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(&socket_path);
        }
    }
}

#[derive(Clone, serde::Serialize)]
pub struct SidecarSnapshot {
    pub socket_path: String,
    pub managed_by_desktop: bool,
    pub process_running: bool,
    pub startup_error: Option<String>,
    pub health: NativeHealthSnapshot,
}

fn attach_log_receiver(manager: NativeSidecarManager, mut rx: tauri::async_runtime::Receiver<CommandEvent>) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    manager
                        .diag_log
                        .push_native_stdout(String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    manager
                        .diag_log
                        .push_native_stderr(String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    manager.diag_log.push_shell_warn(format!(
                        "native-engine exited code={:?} signal={:?}",
                        payload.code, payload.signal
                    ));
                    if let Ok(mut state) = manager.inner.lock() {
                        if state.managed_by_desktop {
                            state.process_running = false;
                            if state.startup_error.is_none() {
                                state.startup_error =
                                    Some("native-engine process exited unexpectedly".to_string());
                            }
                        }
                    }
                    break;
                }
                CommandEvent::Error(err) => {
                    manager
                        .diag_log
                        .push_shell_error(format!("native command error: {err}"));
                }
                _ => {}
            }
        }
    });
}

fn spawn_native_sidecar(
    app: &AppHandle,
    socket_path: &str,
) -> Result<(tauri::async_runtime::Receiver<CommandEvent>, CommandChild), String> {
    let repo_root = resolve_repo_root();
    let binary_path = resolve_native_binary_path(&repo_root)?;

    let sidecar_result = app.shell().sidecar("thestuu-native");

    let command = match sidecar_result {
        Ok(cmd) => cmd,
        Err(sidecar_err) => {
            if !binary_path.is_file() {
                return Err(format!(
                    "{sidecar_err}; dev binary missing at {}",
                    binary_path.display()
                ));
            }
            app.shell().command(binary_path)
        }
    };

    let (rx, child) = command
        .args(["--socket", socket_path])
        .env("STUU_NATIVE_SOCKET", socket_path)
        .env("STUU_ENABLE_TRACKTION", "1")
        .current_dir(&repo_root)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok((rx, child))
}

fn discover_existing_socket() -> Option<String> {
    let preferred = resolve_socket_path();
    if socket_reachable(&preferred, Duration::from_millis(400)) {
        return Some(preferred);
    }

    let temp_dir = std::env::temp_dir();
    let Ok(entries) = std::fs::read_dir(&temp_dir) else {
        return None;
    };

    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("thestuu-native") || !name.ends_with(".sock") {
            continue;
        }
        let path = entry.path();
        let path_str = path.to_string_lossy().to_string();
        if socket_reachable(&path_str, Duration::from_millis(300)) {
            return Some(path_str);
        }
    }

    None
}

fn wait_for_socket(socket_path: &str, timeout_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if socket_reachable(socket_path, Duration::from_millis(300)) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(SOCKET_POLL_MS));
    }
    false
}

pub fn resolve_repo_root() -> PathBuf {
    if let Ok(root) = std::env::var("THESTUU_REPO_ROOT") {
        let path = PathBuf::from(root);
        if path.is_dir() {
            return path;
        }
    }

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| manifest.clone())
}

pub fn resolve_native_binary_path(repo_root: &Path) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("STUU_NATIVE_BIN").or_else(|_| std::env::var("THESTUU_NATIVE_BIN"))
    {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Ok(candidate);
        }
        return Err(format!(
            "STUU_NATIVE_BIN points to missing file: {}",
            candidate.display()
        ));
    }

    let release_dir = repo_root.join("apps/native-engine/build-release");
    let dev_dir = repo_root.join("apps/native-engine/build");
    let names = if cfg!(windows) {
        ["thestuu-native.exe", "thestuu-native.exe"]
    } else {
        ["thestuu-native", "thestuu-native"]
    };

    let candidates = [
        dev_dir.join(names[0]),
        dev_dir.join("Release").join(names[1]),
        release_dir.join(names[0]),
        release_dir.join("Release").join(names[1]),
    ];

    for candidate in &candidates {
        if candidate.is_file() {
            return Ok(candidate.clone());
        }
    }

    Err(format!(
        "native binary not found. Build with CMake or set STUU_NATIVE_BIN. Checked: {}",
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

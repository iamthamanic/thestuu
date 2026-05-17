// TheStuu desktop shell (Tauri v2).
// Window + process lifecycle only — never owns DAW state.
// See docs/desktop-tauri.md and docs/daw-authority-guardrails.md.

mod native_health;
mod native_sidecar;

use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

use native_sidecar::NativeSidecarManager;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

const DEFAULT_DASHBOARD_URL: &str = "http://127.0.0.1:3010";
const STATUS_EVENT: &str = "desktop://status";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStatus {
    pub ui_online: bool,
    pub native_process_running: bool,
    pub native_managed_by_desktop: bool,
    pub ipc_connected: bool,
    pub tracktion_ready: bool,
    pub audio_device_ready: bool,
    pub daw_ready: bool,
    pub startup_error: Option<String>,
    pub socket_path: String,
    pub dashboard_url: String,
}

fn dashboard_url() -> String {
    std::env::var("THESTUU_DASHBOARD_URL").unwrap_or_else(|_| DEFAULT_DASHBOARD_URL.to_string())
}

fn dashboard_socket_addr() -> Option<SocketAddr> {
    let url = dashboard_url();
    let without_scheme = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .unwrap_or(url.as_str());
    let mut addrs = without_scheme.to_socket_addrs().ok()?;
    addrs.next()
}

fn is_dashboard_reachable() -> bool {
    let Some(addr) = dashboard_socket_addr() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_ok()
}

fn build_status(manager: &NativeSidecarManager) -> DesktopStatus {
    let sidecar = manager.snapshot();
    let ui_online = is_dashboard_reachable();
    let ipc_connected = sidecar.health.ipc_connected;
    let tracktion_ready = sidecar.health.tracktion_ready;
    let audio_device_ready = sidecar.health.audio_device_ready;
    let daw_ready = ipc_connected && tracktion_ready && audio_device_ready;

    let startup_error = sidecar
        .startup_error
        .clone()
        .or_else(|| sidecar.health.last_error.clone());

    DesktopStatus {
        ui_online,
        native_process_running: sidecar.process_running,
        native_managed_by_desktop: sidecar.managed_by_desktop,
        ipc_connected,
        tracktion_ready,
        audio_device_ready,
        daw_ready,
        startup_error,
        socket_path: sidecar.socket_path,
        dashboard_url: dashboard_url(),
    }
}

fn emit_status(app: &AppHandle, manager: &NativeSidecarManager) {
    let status = build_status(manager);
    let _ = app.emit(STATUS_EVENT, status);
}

fn start_status_poller(app: AppHandle, manager: Arc<NativeSidecarManager>) {
    std::thread::spawn(move || {
        loop {
            manager.refresh_health();
            emit_status(&app, &manager);

            let status = build_status(&manager);
            if status.ui_online && status.daw_ready {
                if let Some(window) = app.get_webview_window("main") {
                    if let Ok(url) = status.dashboard_url.parse() {
                        let _ = window.navigate(url);
                    }
                }
            }

            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

#[tauri::command]
fn get_desktop_status(manager: State<'_, Arc<NativeSidecarManager>>) -> DesktopStatus {
    manager.refresh_health();
    build_status(&manager)
}

#[tauri::command]
fn get_native_logs(manager: State<'_, Arc<NativeSidecarManager>>) -> Vec<String> {
    manager.logs()
}

#[tauri::command]
fn retry_native_startup(
    app: AppHandle,
    manager: State<'_, Arc<NativeSidecarManager>>,
) -> DesktopStatus {
    manager.retry_startup(&app);
    manager.refresh_health();
    let status = build_status(&manager);
    let _ = app.emit(STATUS_EVENT, &status);
    status
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let native_manager = Arc::new(NativeSidecarManager::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(native_manager.clone())
        .invoke_handler(tauri::generate_handler![
            get_desktop_status,
            get_native_logs,
            retry_native_startup,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            native_manager.startup(&handle);
            native_manager.refresh_health();
            emit_status(&handle, &native_manager);
            start_status_poller(handle, native_manager);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(move |app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(manager) = app_handle.try_state::<Arc<NativeSidecarManager>>() {
                    manager.shutdown_managed();
                }
            }
        });
}

// TheStuu desktop shell (Tauri v2).
// Window + process lifecycle only — never owns DAW state.
// See docs/desktop-tauri.md and docs/daw-authority-guardrails.md.

mod diagnostics;
mod native_health;
mod native_sidecar;

use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

use diagnostics::{
    build_diagnostics, export_bundle, DiagnosticsLog, DesktopDiagnostics, LogEntry,
};
use native_sidecar::NativeSidecarManager;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

const DEFAULT_DASHBOARD_URL: &str = "http://127.0.0.1:3010";
const STATUS_EVENT: &str = "desktop://status";
const DIAGNOSTICS_EVENT: &str = "desktop://diagnostics";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Legacy status payload for offline shell (subset of diagnostics).
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

fn diagnostics_from(d: &DesktopDiagnostics) -> DesktopDiagnostics {
    d.clone()
}

fn status_from_diag(d: &DesktopDiagnostics) -> DesktopStatus {
    DesktopStatus {
        ui_online: d.dashboard_online,
        native_process_running: d.native_process_running,
        native_managed_by_desktop: d.native_managed_by_desktop,
        ipc_connected: d.ipc_connected,
        tracktion_ready: d.tracktion_ready,
        audio_device_ready: d.audio_device_ready,
        daw_ready: d.daw_ready,
        startup_error: d.last_native_error.clone(),
        socket_path: d.socket_path.clone(),
        dashboard_url: d.dashboard_url.clone(),
    }
}

fn build_full_diagnostics(manager: &NativeSidecarManager) -> DesktopDiagnostics {
    build_diagnostics(manager, is_dashboard_reachable(), &dashboard_url())
}

fn emit_diagnostics(app: &AppHandle, manager: &NativeSidecarManager) {
    let diag = build_full_diagnostics(manager);
    let _ = app.emit(DIAGNOSTICS_EVENT, diagnostics_from(&diag));
    let _ = app.emit(STATUS_EVENT, status_from_diag(&diag));
}

fn is_diagnostics_page(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.url().ok())
        .map(|u| u.as_str().contains("diagnostics.html"))
        .unwrap_or(false)
}

fn start_status_poller(app: AppHandle, manager: Arc<NativeSidecarManager>) {
    std::thread::spawn(move || {
        loop {
            manager.refresh_health();
            emit_diagnostics(&app, &manager);

            let diag = build_full_diagnostics(&manager);
            if diag.dashboard_online && diag.daw_ready && !is_diagnostics_page(&app) {
                if let Some(window) = app.get_webview_window("main") {
                    if let Ok(url) = diag.dashboard_url.parse() {
                        let _ = window.navigate(url);
                    }
                }
            }

            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

fn navigate_main_window(app: &AppHandle, path: &str) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let safe_path = path.replace('\\', "\\\\").replace('\'', "\\'");
    let script = format!("window.location.replace('{safe_path}');");
    window.eval(&script).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_desktop_status(manager: State<'_, Arc<NativeSidecarManager>>) -> DesktopStatus {
    status_from_diag(&build_full_diagnostics(&manager))
}

#[tauri::command]
fn get_desktop_diagnostics(manager: State<'_, Arc<NativeSidecarManager>>) -> DesktopDiagnostics {
    build_full_diagnostics(&manager)
}

#[tauri::command]
fn get_diagnostic_logs(manager: State<'_, Arc<NativeSidecarManager>>) -> Vec<LogEntry> {
    manager.diagnostics_log().entries()
}

#[tauri::command]
fn get_native_logs(manager: State<'_, Arc<NativeSidecarManager>>) -> Vec<String> {
    manager
        .diagnostics_log()
        .entries()
        .into_iter()
        .map(|e| format!(
            "[{}] {} {} [{}] {}",
            e.timestamp_ms, e.level, e.source, e.category, e.message
        ))
        .collect()
}

#[tauri::command]
fn clear_diagnostic_logs(manager: State<'_, Arc<NativeSidecarManager>>) {
    manager.diagnostics_log().clear();
    manager
        .diagnostics_log()
        .push_shell_info("diagnostic logs cleared");
}

#[tauri::command]
fn retry_native_startup(
    app: AppHandle,
    manager: State<'_, Arc<NativeSidecarManager>>,
) -> DesktopDiagnostics {
    manager.retry_startup(&app);
    let diag = build_full_diagnostics(&manager);
    emit_diagnostics(&app, &manager);
    diag
}

#[tauri::command]
fn restart_native_engine(
    app: AppHandle,
    manager: State<'_, Arc<NativeSidecarManager>>,
) -> DesktopDiagnostics {
    manager.restart_startup(&app);
    let diag = build_full_diagnostics(&manager);
    emit_diagnostics(&app, &manager);
    diag
}

#[tauri::command]
fn export_diagnostics_bundle(
    manager: State<'_, Arc<NativeSidecarManager>>,
) -> Value {
    let diag = build_full_diagnostics(&manager);
    let logs = manager.diagnostics_log().entries();
    export_bundle(&diag, &logs, APP_VERSION)
}

#[tauri::command]
fn copy_diagnostics_text(manager: State<'_, Arc<NativeSidecarManager>>) -> String {
    let diag = build_full_diagnostics(&manager);
    let logs = manager.diagnostics_log().entries();
    let bundle = export_bundle(&diag, &logs, APP_VERSION);
    serde_json::to_string_pretty(&bundle).unwrap_or_else(|_| "{}".to_string())
}

#[tauri::command]
fn open_diagnostics(app: AppHandle) -> Result<(), String> {
    manager_log_open(&app);
    navigate_main_window(&app, "diagnostics.html")
}

#[tauri::command]
fn open_shell_home(app: AppHandle) -> Result<(), String> {
    navigate_main_window(&app, "index.html")
}

fn manager_log_open(app: &AppHandle) {
    if let Some(manager) = app.try_state::<Arc<NativeSidecarManager>>() {
        manager.diagnostics_log().push_shell_info("diagnostics panel opened");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let diag_log = DiagnosticsLog::new();
    diag_log.push_shell_info(format!("TheStuu desktop shell v{APP_VERSION} starting"));
    let native_manager = Arc::new(NativeSidecarManager::new(diag_log.clone()));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(native_manager.clone())
        .manage(diag_log)
        .invoke_handler(tauri::generate_handler![
            get_desktop_status,
            get_desktop_diagnostics,
            get_diagnostic_logs,
            get_native_logs,
            clear_diagnostic_logs,
            retry_native_startup,
            restart_native_engine,
            export_diagnostics_bundle,
            copy_diagnostics_text,
            open_diagnostics,
            open_shell_home,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            native_manager.startup(&handle);
            native_manager.refresh_health();
            emit_diagnostics(&handle, &native_manager);
            start_status_poller(handle, native_manager);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(move |app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(manager) = app_handle.try_state::<Arc<NativeSidecarManager>>() {
                    manager.diagnostics_log().push_shell_info("desktop shell exiting");
                    manager.shutdown_managed();
                }
            }
        });
}

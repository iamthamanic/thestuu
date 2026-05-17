// TheStuu desktop shell (Tauri v2).
// Window + process lifecycle only — never owns DAW state.
// See docs/desktop-tauri.md and docs/daw-authority-guardrails.md.

use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

use tauri::Manager;

const DEFAULT_DASHBOARD_URL: &str = "http://127.0.0.1:3010";

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

/// Phase 1: TCP probe only (dashboard must already be started via `npm run start`).
fn is_dashboard_reachable() -> bool {
    let Some(addr) = dashboard_socket_addr() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if is_dashboard_reachable() {
                if let Some(window) = app.get_webview_window("main") {
                    if let Ok(url) = dashboard_url().parse() {
                        let _ = window.navigate(url);
                    }
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

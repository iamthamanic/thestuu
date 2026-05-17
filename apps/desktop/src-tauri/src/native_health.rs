// Native-engine IPC health probes (MessagePack over Unix socket).
// Read-only — never mutates DAW state. Used by the desktop shell only.

use std::io::{Read, Write};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

#[cfg(unix)]
use std::os::unix::net::UnixStream;

const FRAME_HEADER_BYTES: usize = 4;
const DEFAULT_SOCKET: &str = "/tmp/thestuu-native.sock";

pub fn resolve_socket_path() -> String {
    std::env::var("STUU_NATIVE_SOCKET")
        .or_else(|_| std::env::var("THESTUU_NATIVE_SOCKET"))
        .unwrap_or_else(|_| DEFAULT_SOCKET.to_string())
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHealthSnapshot {
    pub ipc_connected: bool,
    pub tracktion_ready: bool,
    pub audio_device_ready: bool,
    pub last_error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NativeResponse {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    payload: Option<Value>,
}

/// TCP-style probe: can we connect to the Unix socket?
#[cfg(unix)]
pub fn socket_reachable(socket_path: &str, _timeout: Duration) -> bool {
    UnixStream::connect(socket_path).is_ok()
}

#[cfg(not(unix))]
pub fn socket_reachable(_socket_path: &str, _timeout: Duration) -> bool {
    false
}

#[cfg(unix)]
pub fn probe_native_health(socket_path: &str, timeout: Duration) -> NativeHealthSnapshot {
    let mut snapshot = NativeHealthSnapshot::default();

    let Ok(mut stream) = UnixStream::connect(socket_path) else {
        snapshot.last_error = Some("native socket unreachable".to_string());
        return snapshot;
    };

    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));

    match ipc_request(&mut stream, "health.ping", json!({}), 1) {
        Ok(payload) => {
            if payload.get("pong").and_then(|v| v.as_bool()) == Some(true) {
                snapshot.ipc_connected = true;
            } else {
                snapshot.last_error = Some("health.ping: unexpected payload".to_string());
            }
        }
        Err(err) => {
            snapshot.last_error = Some(format!("health.ping failed: {err}"));
            return snapshot;
        }
    }

    match ipc_request(&mut stream, "backend.info", json!({}), 2) {
        Ok(payload) => {
            snapshot.tracktion_ready =
                payload.get("tracktion").and_then(|v| v.as_bool()).unwrap_or(false);
        }
        Err(err) => {
            snapshot.last_error = Some(format!("backend.info failed: {err}"));
            return snapshot;
        }
    }

    match ipc_request(&mut stream, "audio.get_outputs", json!({}), 3) {
        Ok(payload) => {
            let devices = payload.get("devices").and_then(|v| v.as_array());
            let current = payload
                .get("currentId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            snapshot.audio_device_ready = devices.map(|d| !d.is_empty()).unwrap_or(false)
                || !current.is_empty();
            if !snapshot.audio_device_ready {
                snapshot.last_error = Some("audio.get_outputs: no output devices".to_string());
            }
        }
        Err(err) => {
            snapshot.last_error = Some(format!("audio.get_outputs failed: {err}"));
        }
    }

    snapshot
}

#[cfg(not(unix))]
pub fn probe_native_health(_socket_path: &str, _timeout: Duration) -> NativeHealthSnapshot {
    NativeHealthSnapshot {
        last_error: Some("native IPC health checks require a Unix platform".to_string()),
        ..Default::default()
    }
}

#[cfg(unix)]
fn ipc_request(
    stream: &mut UnixStream,
    cmd: &str,
    payload: Value,
    id: u64,
) -> Result<Value, String> {
    let request = json!({
        "type": "request",
        "id": id,
        "cmd": cmd,
        "payload": payload,
    });

    let body = rmp_serde::to_vec_named(&request).map_err(|e| e.to_string())?;
    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);

    stream
        .write_all(&frame)
        .map_err(|e| format!("write: {e}"))?;

    let response_bytes = read_frame(stream).map_err(|e| format!("read: {e}"))?;
    let message: NativeResponse =
        rmp_serde::from_slice(&response_bytes).map_err(|e| format!("decode: {e}"))?;

    if message.ok == false {
        return Err(message
            .error
            .unwrap_or_else(|| format!("{cmd} returned ok=false")));
    }

    Ok(message.payload.unwrap_or(json!({})))
}

#[cfg(unix)]
fn read_frame(stream: &mut UnixStream) -> Result<Vec<u8>, String> {
    let mut header = [0u8; FRAME_HEADER_BYTES];
    stream
        .read_exact(&mut header)
        .map_err(|e| format!("header: {e}"))?;
    let length = u32::from_be_bytes(header) as usize;
    if length > 8 * 1024 * 1024 {
        return Err("frame too large".to_string());
    }
    let mut body = vec![0u8; length];
    stream
        .read_exact(&mut body)
        .map_err(|e| format!("body: {e}"))?;
    Ok(body)
}

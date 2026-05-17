use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    link_native_sidecar_binary();
    tauri_build::build();
}

/// Tauri externalBin expects `thestuu-native-{TARGET}` beside the dev binary path.
fn link_native_sidecar_binary() {
    let target = match env::var("TARGET") {
        Ok(value) => value,
        Err(_) => return,
    };

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let build_dir = manifest_dir.join("../../native-engine/build");
    let suffixed_name = if cfg!(windows) {
        format!("thestuu-native-{target}.exe")
    } else {
        format!("thestuu-native-{target}")
    };

    let dst = build_dir.join(&suffixed_name);
    if dst.is_file() {
        return;
    }

    let plain_name = if cfg!(windows) {
        "thestuu-native.exe"
    } else {
        "thestuu-native"
    };

    let sources = [
        build_dir.join(plain_name),
        build_dir.join("Release").join(plain_name),
    ];

    for src in &sources {
        if src.is_file() {
            if let Some(parent) = dst.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::copy(src, &dst);
            println!("cargo:rerun-if-changed={}", src.display());
            break;
        }
    }
}

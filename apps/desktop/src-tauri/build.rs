use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    link_native_sidecar_binary();
    tauri_build::build();
}

/// Tauri externalBin expects `thestuu-native-{TARGET_TRIPLE}` next to the path in tauri.conf.json.
fn link_native_sidecar_binary() {
    let target = match env::var("TARGET").or_else(|_| env::var("TAURI_ENV_TARGET_TRIPLE")) {
        Ok(value) => value,
        Err(_) => {
            println!("cargo:warning=TARGET unset; skipping native sidecar link (run npm run build:native-release)");
            return;
        }
    };

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let native_engine = manifest_dir.join("../../native-engine");
    let release_dir = native_engine.join("build-release");
    let dev_dir = native_engine.join("build");
    let suffixed_name = if cfg!(windows) {
        format!("thestuu-native-{target}.exe")
    } else {
        format!("thestuu-native-{target}")
    };

    let plain_name = if cfg!(windows) {
        "thestuu-native.exe"
    } else {
        "thestuu-native"
    };

    let sources = [
        release_dir.join(plain_name),
        release_dir.join("Release").join(plain_name),
        dev_dir.join(plain_name),
        dev_dir.join("Release").join(plain_name),
    ];

    let mut src_path: Option<PathBuf> = None;
    for src in &sources {
        if src.is_file() {
            src_path = Some(src.clone());
            println!("cargo:rerun-if-changed={}", src.display());
            break;
        }
    }

    let Some(src) = src_path else {
        println!(
            "cargo:warning=native binary missing; run: npm run build:native-release (checked release + dev trees)"
        );
        return;
    };

    for out_dir in [release_dir.as_path(), dev_dir.as_path()] {
        let dst = out_dir.join(&suffixed_name);
        if let Some(parent) = dst.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                panic!("create_dir_all {}: {error}", parent.display());
            }
        }
        if let Err(error) = fs::copy(&src, &dst) {
            panic!("copy {} -> {}: {error}", src.display(), dst.display());
        }
        println!("cargo:rerun-if-changed={}", dst.display());
    }
}

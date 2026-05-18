# Native-engine release build

Reproducible **Release + LTO + strip** pipeline for `thestuu-native` (Tauri sidecar / desktop packaging). Binaries and debug bundles are **never committed** — see `.gitignore`.

## Quick start

From repo root (requires `vendor/tracktion_engine` via `./scripts/setup-tracktion.sh`):

```bash
export STUU_NATIVE_VENDOR_DIR="$(pwd)/vendor/tracktion_engine"
npm run build:native-release
bash apps/native-engine/scripts/measure-native-binary.sh
```

Before `npm run desktop:build`:

```bash
npm run build:native-release
npm run desktop:build
```

## Output paths (gitignored)

| Artifact | Path |
|----------|------|
| **Distributable binary** (stripped) | `apps/native-engine/build-release/thestuu-native` |
| Pre-strip copy | `apps/native-engine/build-release/thestuu-native.unstripped` |
| macOS debug symbols | `apps/native-engine/build-release/thestuu-native.dSYM` |
| Linux debug file | `apps/native-engine/build-release/thestuu-native.debug` |
| Dev / CLI binary (unstripped) | `apps/native-engine/build/thestuu-native` |

Tauri `externalBin` points at the **release** path only. `apps/desktop/src-tauri/build.rs` copies that file to the target-triplet suffixed name at bundle time. No binary is checked into git.

## Scripts and presets

| Command | What it does |
|---------|----------------|
| `npm run build:native-release` | Release + LTO + strip (repo root) |
| `npm run build:release --workspace @thestuu/native-engine` | Same |
| `bash apps/native-engine/scripts/build-release.sh` | Direct script |
| `bash apps/native-engine/scripts/build-dev.sh` | Dev tree under `build/` |
| `cmake --preset release` | Configure `build-release/` (set `STUU_THIRD_PARTY_DIR` first) |
| `cmake --build --preset release` | Build only (run strip via `build-release.sh` for packaging) |

## Flags

- **CMAKE_BUILD_TYPE=Release**
- **CMAKE_INTERPROCEDURAL_OPTIMIZATION=ON** (LTO when toolchain supports it)
- **`-ffunction-sections` / `-fdata-sections`** + linker GC (platform-specific)
- **strip** via `scripts/strip-native-binary.sh` after link

## Expected binary size (macOS arm64, Tracktion backend)

Sizes vary with vendor revision and Xcode/Clang version. Typical order of magnitude on Apple Silicon:

| Variant | Approximate size |
|---------|------------------|
| Dev (`build/`, unstripped) | ~20–25 MB |
| Release pre-strip (`build-release/*.unstripped`) | ~18–24 MB |
| Release stripped (`build-release/thestuu-native`) | ~12–20 MB |

Run `bash apps/native-engine/scripts/measure-native-binary.sh` after building both trees for exact bytes on your machine.

## Platform debug symbols

| OS | Preserved artifact |
|----|--------------------|
| macOS | `thestuu-native.dSYM` next to build dir |
| Linux | `thestuu-native.debug` + GNU debug link on binary |
| Windows | PDB workflow documented for future MSVC builds |

## Do not commit

- `apps/native-engine/build/`
- `apps/native-engine/build-release/`
- `vendor/`
- `**/thestuu-native`, `*.dSYM`, `*.debug`

//! Process supervision: the helper is the top-level launcher. It starts the
//! Node bridge via `scripts/start-bridge.bat` and relaunches it if it exits,
//! so a single double-click on the helper boots the whole stack and keeps it
//! up (no more "did I start the bridge?" failure).
//!
//! The bat is launched with MOBILE_SUPERVISED=1 so it skips its trailing
//! `pause` (see start-bridge.bat) and we can observe Node's real lifecycle.

use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::time::{sleep, timeout};

/// Locate `scripts/start-bridge.bat`, honouring an override env var, else
/// walking up from the executable's directory to find the repo root.
fn find_bridge_bat() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("HELPER_BRIDGE").or_else(|_| std::env::var("RUSTDESK_HELPER_BRIDGE")) {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    let exe = std::env::current_exe().ok()?;
    let mut dir: &Path = exe.parent()?;
    loop {
        let candidate = dir.join("scripts").join("start-bridge.bat");
        if candidate.is_file() {
            return Some(candidate);
        }
        dir = dir.parent()?;
    }
}

/// Spawn-and-supervise loop. Runs forever; never returns under normal use.
pub async fn supervise_bridge() {
    let bat = match find_bridge_bat() {
        Some(b) => b,
        None => {
            log::error!(
                "start-bridge.bat not found (set HELPER_BRIDGE to its full path). \
                 Node bridge will NOT be auto-started."
            );
            return;
        }
    };
    let repo_root = bat
        .parent()
        .and_then(|p| p.parent())
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();

    log::info!("supervising Node bridge via {}", bat.display());

    // The first-run wizard starts the Node bridge *before* it starts this
    // desktop helper. Never launch a second bridge against an occupied port:
    // doing so fails with EADDRINUSE, causing repeated terminal windows.
    // A custom port can be provided when server.port is not the default.
    let bridge_port = std::env::var("HELPER_BRIDGE_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(5000);
    let mut backoff = Duration::from_secs(1);
    let mut reported_existing = false;
    loop {
        // Conservatively leave an occupied bridge port alone. The existing
        // server may have interactive PIN auth enabled, which restarting via
        // start-bridge.bat would otherwise silently disable.
        let occupied = matches!(
            timeout(
                Duration::from_millis(500),
                TcpStream::connect(("127.0.0.1", bridge_port)),
            )
            .await,
            Ok(Ok(_))
        );
        if occupied {
            if !reported_existing {
                log::info!(
                    "bridge port {} already in use; using existing server instead of spawning another",
                    bridge_port
                );
                reported_existing = true;
            }
            backoff = Duration::from_secs(1);
            sleep(Duration::from_secs(5)).await;
            continue;
        }
        reported_existing = false;

        // `cmd /c <bat>` runs the batch in this console; MOBILE_SUPERVISED skips its pause.
        let mut child = match Command::new("cmd")
            .arg("/c")
            .arg(&bat)
            .current_dir(&repo_root)
            .env("MOBILE_SUPERVISED", "1")
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                log::error!("failed to launch bridge: {e}; retrying in {:?}", backoff);
                sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
                continue;
            }
        };

        match child.wait().await {
            Ok(status) => log::warn!("Node bridge exited ({status}); relaunching"),
            Err(e) => log::error!("error waiting on bridge: {e}; relaunching"),
        }

        // Bridge stayed up a while -> reset backoff; crash-looping -> back off.
        sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

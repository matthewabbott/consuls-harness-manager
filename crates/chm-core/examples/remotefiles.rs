//! File transfers and moves over SFTP against a real machine, in scratch folders only:
//!
//!   cargo run -p chm-core --example remotefiles -- <host> <user>
//!
//! Uploads (a big one, a taken name numbered, one broken off leaving nothing), a download read
//! back, copies of a file and a folder (never replacing), and moves, also across file systems
//! (home ↔ /dev/shm, where SFTP's rename can't go and `mv` takes over). Uses a private tmux
//! socket, so the machine's sessions are never touched.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, bail, ensure};
use bytes::Bytes;
use chm_core::fs::FsOp;
use chm_core::model::{CoreEvent, HostConfig};
use chm_core::{Core, Sink};

struct Quiet;
impl Sink for Quiet {
    fn event(&self, event: CoreEvent) {
        if let CoreEvent::Notice { level, message, .. } = event {
            println!("  notice [{level:?}] {message}");
        }
    }
    fn alert(&self, _: chm_core::model::Alert) {}
    fn frame(&self, _: Vec<u8>) {}
}

fn stream(chunks: Vec<Vec<u8>>, then: Option<&str>) -> chm_core::fs::ByteStream {
    let (tx, rx) = tokio::sync::mpsc::channel(4);
    let then = then.map(str::to_string);
    tokio::spawn(async move {
        for c in chunks {
            if tx.send(Ok(Bytes::from(c))).await.is_err() {
                return;
            }
        }
        if let Some(e) = then {
            let _ = tx.send(Err(e)).await;
        }
    });
    rx
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (host, user) = (args.first().context("host")?.clone(), args.get(1).context("user")?.clone());
    // SAFETY: set before any other thread reads the environment.
    unsafe { std::env::set_var("CHM_TMUX_SOCKET", format!("chm-test-files-{}", std::process::id())) };
    let data = std::env::temp_dir().join(format!("chm-remotefiles-{}", std::process::id()));
    let core = Core::new(data.clone(), Arc::new(Quiet));
    core.start();
    core.upsert_host(HostConfig::new(&host, &user));

    let start = Instant::now();
    let home = loop {
        if let Ok(out) = core.exec(&host, "printf %s \"$HOME\"").await
            && out.success()
        {
            break out.stdout_str().to_string();
        }
        ensure!(start.elapsed() < Duration::from_secs(30), "never connected");
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    let dir = format!("{home}/.cache/consuls/remotefiles-{}", std::process::id());
    let shm = format!("/dev/shm/chm-remotefiles-{}", std::process::id());
    let out = core.exec(&host, &format!("mkdir -p '{dir}/sub' && (mkdir -p '{shm}' 2>/dev/null || true)")).await.map_err(anyhow::Error::msg)?;
    ensure!(out.success(), "{}", out.stderr_str());
    println!("ok   connected; scratch folder {dir}");
    let result = run(&core, &host, &dir, &shm).await;
    let _ = core.exec(&host, &format!("rm -rf -- '{dir}' '{shm}'")).await;
    core.disconnect(&host);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let _ = std::fs::remove_dir_all(&data);
    result
}

async fn run(core: &Core, host: &str, dir: &str, shm: &str) -> anyhow::Result<()> {
    let ls = async |d: &str| -> anyhow::Result<Vec<String>> {
        let l = core.list_dir(host, d).await.map_err(anyhow::Error::msg)?;
        Ok(l.entries.into_iter().map(|e| e.name).collect())
    };

    // A 3 MB upload in uneven chunks, read back byte for byte.
    let body: Vec<u8> = (0..3_000_017u32).map(|i| (i.wrapping_mul(31) % 251) as u8).collect();
    let chunks: Vec<Vec<u8>> = body.chunks(70_001).map(<[u8]>::to_vec).collect();
    let t = Instant::now();
    let path = core.upload(host, dir, "big.bin", body.len() as u64, stream(chunks, None)).await.map_err(anyhow::Error::msg)?;
    ensure!(path == format!("{dir}/big.bin"), "{path}");
    let up = t.elapsed();
    let t = Instant::now();
    let (size, mut rx) = core.download(host, &path).await.map_err(anyhow::Error::msg)?;
    let mut got = Vec::with_capacity(size as usize);
    while let Some(chunk) = rx.recv().await {
        got.extend_from_slice(&chunk.map_err(anyhow::Error::msg)?);
    }
    ensure!(size == body.len() as u64 && got == body, "downloaded {} of {} bytes, equal: {}", got.len(), body.len(), got == body);
    println!("ok   3 MB up in {up:?}, down in {:?}, identical", t.elapsed());

    let second = core.upload(host, dir, "big.bin", 5, stream(vec![b"small".to_vec()], None)).await.map_err(anyhow::Error::msg)?;
    ensure!(second == format!("{dir}/big (1).bin"), "{second}");
    let broken = core.upload(host, dir, "broken.bin", 100, stream(vec![vec![1; 10]], Some("connection lost"))).await;
    ensure!(broken.is_err(), "a broken-off upload must fail");
    let short = core.upload(host, dir, "short.bin", 100, stream(vec![vec![1; 10]], None)).await;
    ensure!(short.is_err(), "a short upload must fail");
    ensure!(ls(dir).await? == ["sub", "big (1).bin", "big.bin"], "{:?}", ls(dir).await?);
    println!("ok   a taken name is numbered; broken off or short leaves nothing");

    core.fs_op(host, FsOp::Copy { from: format!("{dir}/big.bin"), to: format!("{dir}/sub/copy.bin") }).await.map_err(anyhow::Error::msg)?;
    let again = core.fs_op(host, FsOp::Copy { from: format!("{dir}/big (1).bin"), to: format!("{dir}/sub/copy.bin") }).await;
    ensure!(again.is_err(), "copy replaced a file");
    ensure!(core.stat_file(host, &format!("{dir}/sub/copy.bin")).await.map_err(anyhow::Error::msg)?.map(|s| s.size) == Some(body.len() as u64));
    core.fs_op(host, FsOp::Copy { from: format!("{dir}/sub"), to: format!("{dir}/sub2") }).await.map_err(anyhow::Error::msg)?;
    ensure!(ls(&format!("{dir}/sub2")).await? == ["copy.bin"]);
    ensure!(core.fs_op(host, FsOp::Copy { from: format!("{dir}/sub"), to: format!("{dir}/sub/inner") }).await.is_err(), "copied into itself");
    println!("ok   copies: a file, a folder; never replacing, never into itself");

    core.fs_op(host, FsOp::Rename { from: format!("{dir}/big (1).bin"), to: format!("{dir}/sub/moved.bin") }).await.map_err(anyhow::Error::msg)?;
    let clash = core.fs_op(host, FsOp::Rename { from: format!("{dir}/big.bin"), to: format!("{dir}/sub/moved.bin") }).await;
    ensure!(clash.is_err(), "a move replaced a file");
    if ls(shm).await.is_ok() {
        // Another file system: SFTP's rename fails there, mv moves it.
        core.fs_op(host, FsOp::Rename { from: format!("{dir}/sub2"), to: format!("{shm}/sub2") }).await.map_err(anyhow::Error::msg)?;
        ensure!(ls(&format!("{shm}/sub2")).await? == ["copy.bin"] && !ls(dir).await?.contains(&"sub2".to_string()));
        core.fs_op(host, FsOp::Rename { from: format!("{shm}/sub2"), to: format!("{dir}/back") }).await.map_err(anyhow::Error::msg)?;
        ensure!(ls(&format!("{dir}/back")).await? == ["copy.bin"]);
        println!("ok   moves, also across file systems (home ↔ /dev/shm), never replacing");
    } else {
        println!("ok   moves, never replacing (no /dev/shm here to try another file system)");
    }
    ensure!(core.download(host, dir).await.is_err(), "a folder isn't a download");
    if core.download(host, &format!("{dir}/nothing")).await.is_ok() {
        bail!("downloaded a missing file");
    }
    println!("ok   downloads refuse folders and missing files");
    Ok(())
}

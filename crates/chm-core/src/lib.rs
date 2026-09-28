//! chm-core: everything that talks to remote machines — Tailscale discovery, SSH, tmux
//! control mode, harness adapters and the attention state machine. It deliberately has no
//! Tauri dependency so it can later back an iOS app or an always-on notification daemon.

pub mod harness;
pub mod hub;
pub mod integration;
pub mod local;
pub mod model;
pub mod pty;
pub mod ssh;
pub mod tailscale;
pub mod term;
pub mod tmux;

pub use hub::{Core, Sink};

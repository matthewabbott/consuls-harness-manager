//! The web app's calls into the core, over its WebSocket (`ws.rs`): the same method names and
//! arguments as the desktop app's Tauri commands (`src-tauri/src/commands.rs`), so the UI's
//! backend is one table either way (`src/ipc/backend.ts`). What only makes sense on a desktop is
//! refused.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use chm_core::local::LOCAL_HOST;
use chm_core::model::{FocusState, HostConfig, LabelDef, NewPaneSpec, NotifyPrefs, SoundPrefs, TmuxOp, UiPrefs};

use crate::Daemon;

/// Calls that wait on a machine: run on their own, so a slow one doesn't hold up typing.
pub fn is_slow(method: &str) -> bool {
    matches!(
        method,
        "refresh_tailnet"
            | "fs_op"
            | "fs_count"
            | "read_file"
            | "git_head"
            | "stat_file"
            | "write_file"
            | "git_status"
            | "integration_status"
            | "install_integration"
            | "uninstall_integration"
            | "create_pane"
            | "resize_pane"
            | "tmux_op"
            | "terminate_pane"
            | "list_dir"
            | "download_token"
    )
}

/// The desktop app's commands that the web app doesn't get (the page does some itself:
/// `open_external`; images go through `/api/paste`).
pub const DESKTOP_ONLY: &[&str] =
    &["quit_app", "reveal_path", "vscode_status", "open_in_vscode", "local_drives", "test_chime", "open_external", "save_paste", "read_bytes"];

fn arg<T: DeserializeOwned>(p: &Value, name: &str) -> Result<T, Value> {
    serde_json::from_value(p.get(name).cloned().unwrap_or(Value::Null)).map_err(|e| Value::String(format!("{name}: {e}")))
}

fn ok(v: impl Serialize) -> Result<Value, Value> {
    serde_json::to_value(v).map_err(|e| Value::String(e.to_string()))
}

const DONE: Result<Value, Value> = Ok(Value::Null);

fn err(e: String) -> Value {
    Value::String(e)
}

pub async fn call(d: &Daemon, method: &str, p: Value) -> Result<Value, Value> {
    let core = &d.core;
    let key = || arg::<u32>(&p, "key");
    let host = || arg::<String>(&p, "host");
    let path = || arg::<String>(&p, "path");
    match method {
        // Is the connection alive? (After iOS froze the app, a socket can look open and be dead.)
        "ping" => ok("pong"),
        "get_snapshot" => ok(core.snapshot()),
        // Frames come over the socket anyway; every tile is sent again.
        "subscribe_frames" => {
            core.resend_tiles();
            DONE
        }
        "upsert_host" => {
            let cfg: HostConfig = arg(&p, "config")?;
            if cfg.id.trim().is_empty() || cfg.user.trim().is_empty() {
                return Err(err("a machine and a user are required".into()));
            }
            if !d.me.id.is_empty() && cfg.id.eq_ignore_ascii_case(&d.me.id) {
                return Err(err(format!("{} is the machine this server runs on: it's already there", cfg.id)));
            }
            core.upsert_host(cfg);
            DONE
        }
        "remove_host" => {
            core.remove_host(&arg::<String>(&p, "id")?);
            DONE
        }
        "connect_host" => {
            core.connect(&arg::<String>(&p, "id")?);
            DONE
        }
        "disconnect_host" => {
            core.disconnect(&arg::<String>(&p, "id")?);
            DONE
        }
        "reconnect_host" => {
            core.reconnect(&arg::<String>(&p, "id")?);
            DONE
        }
        "forget_host_key" => {
            core.forget_host_key(&arg::<String>(&p, "id")?);
            DONE
        }
        "refresh_tailnet" => ok(core.refresh_tailnet().await),
        "set_ui_prefs" => {
            core.set_ui_prefs(arg::<UiPrefs>(&p, "prefs")?);
            DONE
        }
        "set_visible_panes" => {
            core.set_visible_panes(arg::<Option<Vec<u32>>>(&p, "keys")?);
            DONE
        }
        "stream_pane" => {
            core.stream_pane(key()?, arg(&p, "on")?);
            DONE
        }
        "send_keys" => {
            core.send_keys(key()?, arg(&p, "keys")?);
            DONE
        }
        "send_text" => {
            core.send_text(key()?, arg(&p, "text")?);
            DONE
        }
        "paste_text" => {
            core.paste_text(key()?, arg(&p, "text")?);
            DONE
        }
        "send_input" => {
            core.send_input(key()?, arg::<String>(&p, "data")?.into_bytes());
            DONE
        }
        "submit_prompt" => {
            core.submit_prompt(key()?, arg(&p, "text")?, arg::<Option<Vec<String>>>(&p, "images")?.unwrap_or_default());
            DONE
        }
        "fs_op" => ok(core.fs_op(&host()?, arg(&p, "op")?).await.map_err(err)?),
        "fs_count" => ok(core.fs_count(&host()?, &path()?).await.map_err(err)?),
        "read_file" => ok(core.read_file(&host()?, &path()?).await.map_err(err)?),
        "git_head" => ok(core.git_head(&host()?, &path()?).await.map_err(err)?),
        "stat_file" => ok(core.stat_file(&host()?, &path()?).await.map_err(err)?),
        "write_file" => match core.write_file(&host()?, &path()?, arg(&p, "text")?, arg(&p, "bom")?, arg(&p, "expect")?).await {
            Ok(stamp) => ok(stamp),
            // The UI tells a conflict from a failure by its kind.
            Err(e) => Err(serde_json::to_value(e).unwrap_or(Value::Null)),
        },
        "git_status" => ok(core.git_status(&host()?, &arg::<String>(&p, "dir")?).await.map_err(err)?),
        "set_pane_bell" => {
            core.set_pane_bell(key()?, arg(&p, "bell")?);
            DONE
        }
        "set_pane_notify" => {
            core.set_pane_notify(key()?, arg(&p, "mode")?);
            DONE
        }
        // Plain shells on the server's machine would die with the server.
        "local_shells" => ok(Vec::<()>::new()),
        "integration_status" => ok(core.integration_status(&host()?).await.map_err(err)?),
        "install_integration" => ok(core.install_integration(&host()?).await.map_err(err)?),
        "uninstall_integration" => ok(core.uninstall_integration(&host()?).await.map_err(err)?),
        "set_notify_prefs" => {
            core.set_notify_prefs(arg::<NotifyPrefs>(&p, "prefs")?);
            DONE
        }
        "set_sound_prefs" => {
            core.set_sound_prefs(arg::<SoundPrefs>(&p, "prefs")?);
            DONE
        }
        "set_focus" => {
            core.set_focus(arg::<FocusState>(&p, "focus")?);
            DONE
        }
        "ack_pane" => {
            core.ack_pane(key()?);
            DONE
        }
        "set_pane_muted" => {
            core.set_pane_muted(key()?, arg(&p, "muted")?);
            DONE
        }
        "create_pane" => {
            let spec: NewPaneSpec = arg(&p, "spec")?;
            if spec.host == LOCAL_HOST && spec.direct == Some(true) {
                return Err(err("plain shells on the server's machine would end with the server: open one in tmux".into()));
            }
            ok(core.create_pane(spec).await.map_err(err)?)
        }
        "resize_pane" => ok(core.resize_pane(key()?, arg(&p, "cols")?, arg(&p, "rows")?).await.map_err(err)?),
        "release_pane_size" => {
            core.release_pane_size(key()?);
            DONE
        }
        "create_label" => {
            let name: String = arg(&p, "name")?;
            if name.trim().is_empty() {
                return Err(err("label name is required".into()));
            }
            ok(core.create_label(&name, &arg::<String>(&p, "color")?))
        }
        "update_label" => {
            core.update_label(arg::<LabelDef>(&p, "label")?);
            DONE
        }
        "delete_label" => {
            core.delete_label(&arg::<String>(&p, "id")?);
            DONE
        }
        "set_pane_labels" => {
            core.set_pane_labels(key()?, arg(&p, "labels")?);
            DONE
        }
        "rename_pane" => {
            core.rename_pane(key()?, arg(&p, "name")?);
            DONE
        }
        "set_pane_hidden" => {
            core.set_pane_hidden(key()?, arg(&p, "hidden")?);
            DONE
        }
        "tmux_op" => ok(core.tmux_op(key()?, arg::<TmuxOp>(&p, "op")?).await.map_err(err)?),
        "terminate_pane" => ok(core.terminate_pane(key()?, arg(&p, "force")?).await.map_err(err)?),
        "list_dir" => ok(core.list_dir(&host()?, &path()?).await.map_err(err)?),
        // A link for `/api/download` (the web app's own call: the desktop reads files directly).
        "download_token" => {
            let (host, path) = (host()?, path()?);
            if core.stat_file(&host, &path).await.map_err(err)?.is_none() {
                return Err(err(format!("{path}: no such file")));
            }
            ok(d.downloads.issue(host, path).map_err(err)?)
        }
        "get_ui_state" => ok(core.ui_state()),
        "set_ui_state" => {
            core.set_ui_state(arg(&p, "key")?, arg(&p, "value")?);
            DONE
        }
        m if DESKTOP_ONLY.contains(&m) => Err(err(format!("{m} isn't available in the web app"))),
        m => Err(err(format!("unknown method {m}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every command the UI calls is handled here or refused on purpose: the two lists can't
    /// drift apart unnoticed.
    #[test]
    fn covers_every_command_the_ui_calls() {
        let backend = include_str!("../../../src/ipc/backend.ts");
        let handled = include_str!("rpc.rs");
        // `call<T>("name"` and `invoke("name"`.
        let mut names: Vec<&str> = backend
            .split("call")
            .chain(backend.split("invoke"))
            .skip(1)
            .filter_map(|rest| {
                let rest = if rest.starts_with('<') { &rest[rest.find(">(")? + 1..] } else { rest };
                rest.strip_prefix("(\"")?.split('"').next()
            })
            .collect();
        names.sort();
        names.dedup();
        assert!(names.len() > 40, "found the commands in backend.ts ({})", names.len());
        for name in names {
            assert!(handled.contains(&format!("\"{name}\" =>")) || DESKTOP_ONLY.contains(&name), "{name} is neither handled nor desktop-only");
        }
    }

    #[test]
    fn arguments() {
        let p = serde_json::json!({ "key": 7, "on": true, "keys": ["Up"], "images": null });
        assert_eq!(arg::<u32>(&p, "key").unwrap(), 7);
        assert!(arg::<bool>(&p, "on").unwrap());
        assert_eq!(arg::<Option<Vec<String>>>(&p, "images").unwrap(), None);
        assert_eq!(arg::<Option<u32>>(&p, "missing").unwrap(), None, "a missing optional is None");
        assert!(arg::<u32>(&p, "missing").unwrap_err().as_str().unwrap().starts_with("missing"));
    }
}

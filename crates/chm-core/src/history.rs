//! Recent agent sessions on a machine, from the harnesses' own session files: Claude Code
//! (`~/.claude/projects/<dir>/<id>.jsonl`), Codex (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`),
//! pi (`~/.pi/agent/sessions/<dir>/*.jsonl`) and omp (`~/.omp/agent/sessions/<dir>/*.jsonl`).
//! Sessions started outside Consuls are there too, and every device sees the same list.
//!
//! [`SCRIPT`] runs on the machine and prints only a few lines per session (cut short), so a
//! session file of tens of megabytes costs a few kilobytes; [`parse`] makes summaries of them.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::harness::Harness;
use crate::model::HostId;

/// One agent session, for browsing and reopening.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SessionSummary {
    pub host: HostId,
    pub harness: Harness,
    /// The harness's session id: what its hooks report, kept on the pane it runs in
    /// (`PaneInfo::session`).
    pub id: String,
    /// What [`crate::model::NewPaneSpec::resume`] takes to reopen it: the id, or the session
    /// file (pi, omp).
    pub resume: String,
    /// The folder it ran in.
    pub cwd: String,
    /// The harness's own title: your rename or Claude Code's AI title, Codex's thread name,
    /// pi's session name, omp's title.
    pub title: Option<String>,
    pub first_prompt: Option<String>,
    pub last_prompt: Option<String>,
    /// When its file was last written (unix seconds).
    #[ts(type = "number")]
    pub last_active: u64,
}

/// Lists the newest sessions (at most 80, of the last 30 days) and prints, per session, an
/// `F <harness> <mtime> <path>` line and then tagged lines: `H` its header lines, `B` the first
/// user messages (in its first megabyte; not Claude Code's `<command-name>` and such), `E` the
/// last line of each kind in its last 8 MB (titles, the last prompt), `C` its folder (Claude
/// Code), `N` its thread name (Codex). Sessions run without a person (`claude -p`, `codex exec`)
/// are skipped, as the harnesses' own pickers do. `dd` reads the ends (BSD `tail -c` copies byte
/// by byte), and patterns are one regex each (BSD grep is slow with several `-e`).
pub const SCRIPT: &str = r#"export LC_ALL=C
days=30 max=80 win=8388608
claude=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects
codex=${CODEX_HOME:-$HOME/.codex}
pi=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions
omp=$HOME/.omp/agent/sessions
if stat -c %Y / >/dev/null 2>&1; then fmt=-c spec='%Y %s %n'; else fmt=-f spec='%m %z %N'; fi
list() {
  h=$1 d=$2
  shift 2
  [ -d "$d" ] && find -H "$d" "$@" -mtime -$days -exec stat $fmt "$spec" {} + 2>/dev/null | sed "s|^|$h |"
}
emit() { cut -c1-$1 | sed "s/^/$2 /"; }
headwin() { dd if="$f" bs=65536 count=16 2>/dev/null; }
tailwin() { dd if="$f" bs=65536 skip=$(( sz > win ? (sz - win) / 65536 : 0 )) 2>/dev/null; }
lastof() { cut -c1-1500 | awk 'match($0, /"type":"[^"]*"/) { v[substr($0, RSTART, RLENGTH)] = $0 } END { for (k in v) print "E " v[k] }'; }
{
  list claude "$claude" -mindepth 2 -maxdepth 2 -name '*.jsonl'
  list codex "$codex/sessions" -name 'rollout-*.jsonl'
  list pi "$pi" -mindepth 2 -maxdepth 2 -name '*.jsonl'
  list omp "$omp" -mindepth 2 -maxdepth 2 -name '*.jsonl'
} | sort -k2,2nr | head -n 400 | {
  n=0
  while read -r h mt sz f; do
    [ "$n" -lt "$max" ] || break
    case $h in
    claude)
      case ${f##*/} in agent-*) continue ;; esac
      case $(headwin | grep -a -m 1 -o '"entrypoint":"[^"]*"') in *sdk*) continue ;; esac ;;
    codex)
      head -n 1 "$f" | grep -a -q -E '"source":"exec"|"originator":"codex_exec"' && continue ;;
    esac
    n=$((n + 1))
    printf 'F %s %s %s\n' "$h" "$mt" "$f"
    case $h in
    claude)
      headwin | grep -a -m 1 -o '"cwd":"[^"]*"' | emit 2000 C
      u='"type":"user","message":{"role":"user","content":"'
      headwin | grep -a -F "$u" | grep -a -v -F "$u<" | head -n 4 | emit 1500 B
      tailwin | grep -a -E '^[{]"type":"(ai-title|custom-title|last-prompt","lastPrompt|relocated|continued-in)"' | lastof ;;
    codex)
      head -n 1 "$f" | emit 1500 H
      headwin | grep -a -m 3 -E '"type":"(user_message|UserMessage)"' | emit 1500 B
      tailwin | grep -a -E '"type":"(user_message|UserMessage)"' | lastof
      id=${f##*/} && id=${id%.jsonl} && id=${id#rollout-*T??-??-??-}
      [ -f "$codex/session_index.jsonl" ] && grep -a -F "\"$id\"" "$codex/session_index.jsonl" | tail -n 1 | emit 600 N ;;
    *)
      head -n 2 "$f" | emit 1500 H
      headwin | grep -a -m 3 -F '"message":{"role":"user"' | emit 1500 B
      tailwin | grep -a -E '"message":[{]"role":"user"|^[{]"type":"(session_info|title_change)"' | lastof ;;
    esac
  done
}
exit 0"#;

/// What the script printed about one session file.
#[derive(Default)]
struct Raw<'a> {
    harness: Option<Harness>,
    mtime: u64,
    path: &'a str,
    head: Vec<&'a str>,
    begin: Vec<&'a str>,
    end: Vec<&'a str>,
    cwd: Option<&'a str>,
    name: Option<&'a str>,
}

/// The summaries in [`SCRIPT`]'s output, newest first.
pub fn parse(host: &str, out: &str) -> Vec<SessionSummary> {
    let mut raws: Vec<Raw> = Vec::new();
    for line in out.lines() {
        let Some((tag, rest)) = line.split_once(' ') else { continue };
        if tag == "F" {
            let mut f = rest.splitn(3, ' ');
            let (Some(h), Some(mtime), Some(path)) = (f.next(), f.next(), f.next()) else { continue };
            raws.push(Raw { harness: Harness::from_name(h), mtime: mtime.parse().unwrap_or(0), path, ..Default::default() });
            continue;
        }
        let Some(raw) = raws.last_mut() else { continue };
        // A line the tail window cut into isn't a whole record.
        if tag != "C" && !rest.starts_with('{') {
            continue;
        }
        match tag {
            "H" => raw.head.push(rest),
            "B" => raw.begin.push(rest),
            "E" => raw.end.push(rest),
            "C" => raw.cwd = Some(rest),
            "N" => raw.name = Some(rest),
            _ => {}
        }
    }

    // Each with the session it carried on in, if any (Claude Code).
    let built: Vec<(SessionSummary, Option<String>)> = raws
        .iter()
        .filter_map(|raw| {
            let (s, next) = match raw.harness? {
                Harness::Claude => claude(host, raw),
                Harness::Codex => (codex(host, raw)?, None),
                h @ (Harness::Pi | Harness::Omp) => (pi(host, h, raw)?, None),
                _ => return None,
            };
            (s.title.is_some() || s.first_prompt.is_some() || s.last_prompt.is_some()).then_some((s, next))
        })
        .collect();
    // The session another one carried on in stands for both, when it's listed.
    let ids: std::collections::HashSet<String> = built.iter().map(|(s, _)| s.id.clone()).collect();
    let mut sessions: Vec<SessionSummary> = built.into_iter().filter(|(_, next)| !next.as_ref().is_some_and(|n| ids.contains(n))).map(|(s, _)| s).collect();
    sessions.sort_by_key(|s| std::cmp::Reverse(s.last_active));
    sessions
}

fn stem(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.strip_suffix(".jsonl").unwrap_or(name)
}

/// The last `E` line of a kind (`"type":"<kind>"`).
fn last_of<'a>(lines: &[&'a str], kind: &str) -> Option<&'a str> {
    let needle = format!("\"type\":\"{kind}\"");
    lines.iter().rev().find(|l| l.contains(&needle)).copied()
}

/// Claude Code, and the session it carried on in, if it did.
fn claude(host: &str, raw: &Raw) -> (SessionSummary, Option<String>) {
    let id = stem(raw.path).to_string();
    let relocated = last_of(&raw.end, "relocated").and_then(|l| json_str(l, "relocatedCwd"));
    let cwd = relocated
        .or_else(|| raw.cwd.and_then(|c| json_str(c, "cwd")))
        .or_else(|| raw.begin.iter().find_map(|l| json_str(l, "cwd")))
        .unwrap_or_default();
    let title = last_of(&raw.end, "custom-title")
        .and_then(|l| json_str(l, "customTitle"))
        .or_else(|| last_of(&raw.end, "ai-title").and_then(|l| json_str(l, "aiTitle")))
        .and_then(|t| clean(&t, TITLE_CHARS));
    let first_prompt = raw.begin.iter().find_map(|l| claude_prompt(l));
    let last_prompt = last_of(&raw.end, "last-prompt").and_then(|l| json_str(l, "lastPrompt")).and_then(|t| clean(&t, PROMPT_CHARS));
    let next = last_of(&raw.end, "continued-in").and_then(|l| json_str(l, "continuedInSessionId"));
    let s = SessionSummary {
        host: host.into(),
        harness: Harness::Claude,
        resume: id.clone(),
        id,
        cwd,
        title,
        first_prompt,
        last_prompt,
        last_active: raw.mtime,
    };
    (s, next)
}

/// What a person typed, from a Claude Code `user` line: not a command's output, a reminder or
/// another synthetic message (newer versions say where a message came from in `origin`).
fn claude_prompt(line: &str) -> Option<String> {
    const ORIGIN: &str = "\"origin\":{\"kind\":\"";
    let from_elsewhere = line.find(ORIGIN).is_some_and(|at| !line[at + ORIGIN.len()..].starts_with("human\""));
    if from_elsewhere || line.contains("\"isMeta\":true") || line.contains("\"isCompactSummary\":true") {
        return None;
    }
    prompt(&json_str(line, "content")?)
}

fn codex(host: &str, raw: &Raw) -> Option<SessionSummary> {
    let meta = raw.head.first().copied().unwrap_or("");
    let stem = stem(raw.path);
    let id = match stem.get(stem.len().saturating_sub(36)..) {
        Some(tail) if is_uuid(tail) => tail.to_string(),
        _ => json_str(meta, "id")?,
    };
    let text = |l: &&str| if l.contains("\"type\":\"user_message\"") { json_str(l, "message") } else { json_str(l, "text") };
    Some(SessionSummary {
        host: host.into(),
        harness: Harness::Codex,
        resume: id.clone(),
        id,
        cwd: json_str(meta, "cwd").unwrap_or_default(),
        title: raw.name.and_then(|l| json_str(l, "thread_name")).and_then(|t| clean(&t, TITLE_CHARS)),
        first_prompt: raw.begin.iter().find_map(|l| prompt(&text(l)?)),
        last_prompt: raw.end.iter().rev().find_map(|l| prompt(&text(l)?)),
        last_active: raw.mtime,
    })
}

/// pi and omp (omp is pi's descendant): a `session` header, then entries; titles in
/// `session_info` (pi's names) or omp's `title` header and `title_change` entries.
fn pi(host: &str, harness: Harness, raw: &Raw) -> Option<SessionSummary> {
    let header = raw.head.iter().find(|l| l.starts_with("{\"type\":\"session\""))?;
    let id = json_str(header, "id")?;
    let title = match last_of(&raw.end, "session_info") {
        // An empty name clears it.
        Some(info) => json_str(info, "name"),
        None => last_of(&raw.end, "title_change")
            .or_else(|| raw.head.iter().find(|l| l.starts_with("{\"type\":\"title\"")).copied())
            .and_then(|l| json_str(l, "title")),
    }
    .and_then(|t| clean(&t, TITLE_CHARS));
    let text = |l: &&str| json_str(l, "content").or_else(|| json_str(l, "text"));
    Some(SessionSummary {
        host: host.into(),
        harness,
        id,
        resume: raw.path.to_string(),
        cwd: json_str(header, "cwd").unwrap_or_default(),
        title,
        first_prompt: raw.begin.iter().find_map(|l| prompt(&text(l)?)),
        last_prompt: last_of(&raw.end, "message").and_then(|l| prompt(&text(&l)?)),
        last_active: raw.mtime,
    })
}

const TITLE_CHARS: usize = 160;
const PROMPT_CHARS: usize = 300;

/// A user message worth showing: not markup the harness wrapped around it (`<environment_context>`,
/// `<command-name>`, …), its instructions files, or an interruption notice.
fn prompt(text: &str) -> Option<String> {
    let text = unwrap_pasted(text);
    let t = text.trim_start();
    let synthetic = t.starts_with('<') || t.starts_with("[Request interrupted") || t.starts_with("# AGENTS.md instructions") || t.starts_with("Caveat:");
    if synthetic { None } else { clean(t, PROMPT_CHARS) }
}

/// Claude Code keeps a long paste as `<pasted_content id="…">…</pasted_content id="…">`: the
/// paste is what was typed.
fn unwrap_pasted(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = [rest.find("<pasted_content"), rest.find("</pasted_content")].into_iter().flatten().min() {
        out.push_str(&rest[..at]);
        out.push(' ');
        rest = rest[at..].find('>').map_or("", |end| &rest[at + end + 1..]);
    }
    out.push_str(rest);
    out
}

/// One line of at most `max` characters (the script may have cut a character in half).
fn clean(text: &str, max: usize) -> Option<String> {
    let one: String = text.trim_end_matches('\u{FFFD}').split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = one.chars().take(max).collect();
    if one.chars().count() > max {
        out.push('…');
    }
    (!out.is_empty()).then_some(out)
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36 && s.bytes().enumerate().all(|(i, b)| if matches!(i, 8 | 13 | 18 | 23) { b == b'-' } else { b.is_ascii_hexdigit() })
}

/// The first `"key":"…"` string in a JSON line that may have been cut short: what's there of
/// it, unescaped.
fn json_str(line: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":");
    let mut from = 0;
    while let Some(at) = line[from..].find(&needle) {
        let after = from + at + needle.len();
        let rest = line[after..].trim_start();
        if let Some(body) = rest.strip_prefix('"') {
            return Some(unescape(body));
        }
        from = after;
    }
    None
}

/// A JSON string's characters up to its closing quote (or the end of a cut-short line).
fn unescape(body: &str) -> String {
    let mut out = String::new();
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => break,
            '\\' => match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('r') => out.push('\r'),
                Some('b' | 'f') => out.push(' '),
                Some('u') => {
                    let hex: String = chars.by_ref().take(4).collect();
                    let Ok(mut code) = u32::from_str_radix(&hex, 16) else { break };
                    if hex.len() < 4 {
                        break; // cut off inside the escape
                    }
                    // A surrogate pair: the low half follows as another \u escape.
                    if (0xD800..0xDC00).contains(&code) {
                        let rest = chars.as_str();
                        match rest.strip_prefix("\\u").and_then(|r| r.get(..4)).and_then(|h| u32::from_str_radix(h, 16).ok()) {
                            Some(low) if (0xDC00..0xE000).contains(&low) => {
                                code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                                chars = rest[6..].chars();
                            }
                            _ => code = 0xFFFD,
                        }
                    }
                    out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                }
                Some(other) => out.push(other),
                None => break,
            },
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_strings_even_cut_short() {
        assert_eq!(json_str(r#"{"a":1,"cwd":"/x/y","b":2}"#, "cwd").as_deref(), Some("/x/y"));
        assert_eq!(json_str(r#"{"session_id":"s","id":"i"}"#, "id").as_deref(), Some("i"));
        assert_eq!(json_str(r#"{"message":{"role":"user"},"x":1}"#, "message"), None);
        assert_eq!(json_str(r#"{"t": "spaced"}"#, "t").as_deref(), Some("spaced"));
        assert_eq!(json_str(r#"{"t":"line\nnext \"q\" \\ \u00e9\ud83d\ude00"}"#, "t").as_deref(), Some("line\nnext \"q\" \\ é😀"));
        assert_eq!(json_str(r#"{"t":"cut off in the mid"#, "t").as_deref(), Some("cut off in the mid"));
        assert_eq!(json_str(r#"{"t":"half an escape \u00"#, "t").as_deref(), Some("half an escape "));
        assert_eq!(json_str(r#"{"cwd":"C:\\Users\\a"}"#, "cwd").as_deref(), Some(r"C:\Users\a"));
    }

    #[test]
    fn prompts_and_titles() {
        assert_eq!(prompt("  fix the\n\nbuild  ").as_deref(), Some("fix the build"));
        assert_eq!(prompt("<command-name>/clear</command-name>"), None);
        assert_eq!(prompt("[Request interrupted by user]"), None);
        assert_eq!(prompt("# AGENTS.md instructions for /x"), None);
        assert_eq!(prompt("\n\n<pasted_content id=\"p1\">a long\npaste</pasted_content id=\"p1\">\n").as_deref(), Some("a long paste"));
        assert_eq!(prompt("see <pasted_content id=\"p1\">this, cut sho").as_deref(), Some("see this, cut sho"));
        assert_eq!(clean(&"é".repeat(200), 160).map(|t| t.chars().count()), Some(161));
        assert_eq!(clean("cut\u{FFFD}", 10).as_deref(), Some("cut"));
        assert_eq!(clean("   ", 10), None);
        assert!(is_uuid("019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5b") && !is_uuid("019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5"));
    }

    /// Output as the script prints it, for fixtures in each harness's format (synthetic).
    const OUT: &str = concat!(
        "F claude 1790000300 /h/.claude/projects/-h-code-app/0b5a3f0e-1111-4222-8333-944455556666.jsonl\n",
        "C \"cwd\":\"/h/code/app\"\n",
        "B {\"parentUuid\":null,\"isSidechain\":false,\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<local-command-caveat>Caveat: generated</local-command-caveat>\"},\"isMeta\":true}\n",
        "B {\"parentUuid\":\"a\",\"isSidechain\":false,\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Add a dark mode toggle to the settings page\"},\"origin\":{\"kind\":\"human\"},\"cwd\":\"/h/code/app\"}\n",
        "E {\"type\":\"last-prompt\",\"lastPrompt\":\"now make the toggle remember its state\",\"sessionId\":\"0b5a3f0e-1111-4222-8333-944455556666\"}\n",
        "E {\"type\":\"ai-title\",\"aiTitle\":\"Dark mode toggle\",\"sessionId\":\"0b5a3f0e-1111-4222-8333-944455556666\"}\n",
        "F codex 1790000200 /h/.codex/sessions/2026/10/20/rollout-2026-10-20T10-11-12-019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5b.jsonl\n",
        "H {\"timestamp\":\"2026-10-20T10:11:12Z\",\"type\":\"session_meta\",\"payload\":{\"session_id\":\"x\",\"id\":\"019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5b\",\"cwd\":\"/h/code/api\",\"originator\":\"codex-tui\",\"source\":\"cli\",\"base_instructions\":{\"text\":\"You are\n",
        "B {\"timestamp\":\"t\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"Why does the login test flake?\",\"images\":[]}}\n",
        "E {\"timestamp\":\"t\",\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"item\":{\"type\":\"UserMessage\",\"id\":\"u\",\"content\":[{\"type\":\"text\",\"text\":\"ok, add a retry and rerun\"}]}}}\n",
        "N {\"id\":\"019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5b\",\"thread_name\":\"Login test flake\",\"updated_at\":\"t\"}\n",
        "F omp 1790000100 /h/.omp/agent/sessions/-code-bot/2026-10-19T09-00-00-000Z_01a10225-bddd-75a1-9ca6-79bcd69647af.jsonl\n",
        "H {\"type\":\"title\",\"v\":1,\"title\":\"Old title\",\"source\":\"auto\",\"pad\":\"   \"}\n",
        "H {\"type\":\"session\",\"version\":3,\"id\":\"01a10225-bddd-75a1-9ca6-79bcd69647af\",\"timestamp\":\"t\",\"cwd\":\"/h/code/bot\"}\n",
        "B {\"type\":\"message\",\"id\":\"1\",\"parentId\":\"0\",\"timestamp\":\"t\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Port the bot to the new API\"}]}}\n",
        "E {\"type\":\"title_change\",\"id\":\"2\",\"parentId\":\"1\",\"timestamp\":\"t\",\"title\":\"Bot API port\",\"source\":\"auto\"}\n",
        "E {\"type\":\"message\",\"id\":\"9\",\"parentId\":\"8\",\"timestamp\":\"t\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"ship it\"}]}}\n",
        "F pi 1790000050 /h/.pi/agent/sessions/--h-code-site--/2026-10-18T08-00-00-000Z_7d1e.jsonl\n",
        "H {\"type\":\"session\",\"version\":3,\"id\":\"7d1e0000-aaaa-4bbb-8ccc-dddddddddddd\",\"timestamp\":\"t\",\"cwd\":\"/h/code/site\"}\n",
        "H {\"type\":\"model_change\",\"id\":\"1\"}\n",
        "B {\"type\":\"message\",\"id\":\"2\",\"parentId\":\"1\",\"timestamp\":\"t\",\"message\":{\"role\":\"user\",\"content\":\"Write the release notes\",\"timestamp\":1}}\n",
        "E {\"type\":\"session_info\",\"id\":\"3\",\"parentId\":\"2\",\"timestamp\":\"t\",\"name\":\"Release notes\"}\n",
        "E {\"type\":\"message\",\"id\":\"4\",\"parentId\":\"3\",\"timestamp\":\"t\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"shorter please\"}]}}\n",
        "F claude 1790000400 /h/.claude/projects/-h/aaaaaaaa-0000-4000-8000-000000000000.jsonl\n",
        "E {\"type\":\"last-prompt\",\"leafUuid\":\"x\",\"sessionId\":\"aaaaaaaa-0000-4000-8000-000000000000\"}\n",
    );

    #[test]
    fn parses_each_harness() {
        let s = parse("spark2", OUT);
        assert_eq!(s.len(), 4, "the empty session is left out: {s:#?}");
        let claude = &s[0];
        assert_eq!((claude.harness, claude.id.as_str(), claude.resume.as_str()), (Harness::Claude, "0b5a3f0e-1111-4222-8333-944455556666", "0b5a3f0e-1111-4222-8333-944455556666"));
        assert_eq!((claude.cwd.as_str(), claude.title.as_deref()), ("/h/code/app", Some("Dark mode toggle")));
        assert_eq!(claude.first_prompt.as_deref(), Some("Add a dark mode toggle to the settings page"));
        assert_eq!(claude.last_prompt.as_deref(), Some("now make the toggle remember its state"));
        assert_eq!((claude.host.as_str(), claude.last_active), ("spark2", 1_790_000_300));

        let codex = &s[1];
        assert_eq!((codex.harness, codex.id.as_str(), codex.cwd.as_str()), (Harness::Codex, "019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5b", "/h/code/api"));
        assert_eq!(codex.title.as_deref(), Some("Login test flake"));
        assert_eq!(codex.first_prompt.as_deref(), Some("Why does the login test flake?"));
        assert_eq!(codex.last_prompt.as_deref(), Some("ok, add a retry and rerun"));

        let omp = &s[2];
        assert_eq!((omp.harness, omp.id.as_str()), (Harness::Omp, "01a10225-bddd-75a1-9ca6-79bcd69647af"));
        assert!(omp.resume.ends_with("_01a10225-bddd-75a1-9ca6-79bcd69647af.jsonl"), "omp resumes by file");
        assert_eq!((omp.cwd.as_str(), omp.title.as_deref()), ("/h/code/bot", Some("Bot API port")));
        assert_eq!((omp.first_prompt.as_deref(), omp.last_prompt.as_deref()), (Some("Port the bot to the new API"), Some("ship it")));

        let pi = &s[3];
        assert_eq!((pi.harness, pi.id.as_str(), pi.cwd.as_str()), (Harness::Pi, "7d1e0000-aaaa-4bbb-8ccc-dddddddddddd", "/h/code/site"));
        assert_eq!((pi.title.as_deref(), pi.first_prompt.as_deref(), pi.last_prompt.as_deref()), (Some("Release notes"), Some("Write the release notes"), Some("shorter please")));
    }

    #[test]
    fn titles_fall_back_and_sessions_that_carried_on_merge() {
        let out = concat!(
            "F claude 20 /p/new.jsonl\n",
            "B {\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"second part\"}}\n",
            "F claude 10 /p/old.jsonl\n",
            "B {\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first part\"},\"origin\":{\"kind\":\"task-notification\"}}\n",
            "B {\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"first part, typed\"},\"origin\":{\"kind\":\"human\"}}\n",
            "E {\"type\":\"custom-title\",\"customTitle\":\"Mine\",\"sessionId\":\"old\"}\n",
            "E {\"type\":\"ai-title\",\"aiTitle\":\"Theirs\",\"sessionId\":\"old\"}\n",
            "E {\"type\":\"continued-in\",\"timestamp\":\"t\",\"sessionId\":\"old\",\"continuedInSessionId\":\"new\"}\n",
            "F claude 5 /p/alone.jsonl\n",
            "B {\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"lonely\"}}\n",
            "E {\"type\":\"continued-in\",\"timestamp\":\"t\",\"sessionId\":\"alone\",\"continuedInSessionId\":\"gone\"}\n",
            "E ture\",\"aiTitle\":\"a line the tail window cut into\"}\n",
        );
        let s = parse("h", out);
        assert_eq!(s.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["new", "alone"]);
        assert_eq!((s[0].title.as_deref(), s[0].first_prompt.as_deref()), (None, Some("second part")));
        assert_eq!(s[1].title, None);
        let old = parse("h", &out.replace("continuedInSessionId\":\"new", "continuedInSessionId\":\"elsewhere"));
        let old = old.iter().find(|s| s.id == "old").unwrap();
        assert_eq!((old.title.as_deref(), old.first_prompt.as_deref()), (Some("Mine"), Some("first part, typed")));
    }

    /// The script on fixture files in a scratch home (where a POSIX shell is available).
    #[test]
    fn script_finds_sessions_in_a_home() {
        let Some(sh) = ["/bin/sh"].into_iter().find(|p| std::path::Path::new(p).exists()) else { return };
        let home = std::env::temp_dir().join(format!("chm-history-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let write = |rel: &str, lines: &[String]| {
            let p = home.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, lines.join("\n") + "\n").unwrap();
        };
        let id = "0b5a3f0e-1111-4222-8333-944455556666";
        let user = |text: &str, extra: &str| format!(r#"{{"parentUuid":null,"isSidechain":false,"type":"user","message":{{"role":"user","content":"{text}"}}{extra},"entrypoint":"cli","cwd":"/w/app","sessionId":"{id}"}}"#);
        let tool = r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t","type":"tool_result","content":"lots of output"}]}}"#.to_string();
        write(
            &format!(".claude/projects/-w-app/{id}.jsonl"),
            &[
                format!(r#"{{"type":"mode","mode":"normal","sessionId":"{id}"}}"#),
                // Slash commands first: they don't take the first prompt's place.
                user("<local-command-caveat>Caveat: …</local-command-caveat>", r#","isMeta":true"#),
                user("<command-name>/model</command-name>", ""),
                user("<local-command-stdout>Set model</local-command-stdout>", ""),
                user("<command-name>/clear</command-name>", ""),
                user("<local-command-stdout></local-command-stdout>", ""),
                user("Add a dark mode toggle", ""),
                tool.clone(),
                format!(r#"{{"type":"ai-title","aiTitle":"Dark mode","sessionId":"{id}"}}"#),
                user(&"long ".repeat(2000), ""),
                format!(r#"{{"type":"last-prompt","lastPrompt":"remember the choice","sessionId":"{id}"}}"#),
            ],
        );
        // Run without a person (`claude -p`), and a subagent's transcript: not listed.
        write(".claude/projects/-w-app/11111111-2222-4333-8444-555555555555.jsonl", &[r#"{"type":"user","message":{"role":"user","content":"automated"},"entrypoint":"sdk-cli"}"#.into()]);
        write(&format!(".claude/projects/-w-app/{id}/subagents/agent-1.jsonl"), &[user("subagent", "")]);
        let codex = "019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5b";
        write(
            &format!(".codex/sessions/2026/10/20/rollout-2026-10-20T10-11-12-{codex}.jsonl"),
            &[
                format!(r#"{{"timestamp":"t","type":"session_meta","payload":{{"id":"{codex}","cwd":"/w/api","originator":"codex-tui","source":"cli"}}}}"#),
                r#"{"timestamp":"t","type":"event_msg","payload":{"type":"user_message","message":"Why does it flake?"}}"#.into(),
                r#"{"timestamp":"t","type":"event_msg","payload":{"type":"user_message","message":"add a retry"}}"#.into(),
            ],
        );
        write(".codex/sessions/2026/10/20/rollout-2026-10-20T11-00-00-019a1b2c-0000-7f00-8a9b-0c1d2e3f4a5b.jsonl", &[r#"{"type":"session_meta","payload":{"id":"x","cwd":"/w","originator":"codex_exec","source":"exec"}}"#.into()]);
        write(".codex/session_index.jsonl", &[format!(r#"{{"id":"{codex}","thread_name":"Flaky login","updated_at":"t"}}"#)]);
        write(
            ".pi/agent/sessions/--w-my site--/2026-10-18T08-00-00-000Z_7d1e0000-aaaa-4bbb-8ccc-dddddddddddd.jsonl",
            &[
                r#"{"type":"session","version":3,"id":"7d1e0000-aaaa-4bbb-8ccc-dddddddddddd","timestamp":"t","cwd":"/w/my site"}"#.into(),
                r#"{"type":"message","id":"2","parentId":"1","timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"Write the notes"}]}}"#.into(),
                r#"{"type":"session_info","id":"3","parentId":"2","timestamp":"t","name":"Notes"}"#.into(),
            ],
        );
        // Older than 30 days: not listed.
        write(".omp/agent/sessions/-w/old.jsonl", &[r#"{"type":"session","id":"o","cwd":"/w"}"#.into()]);
        let old = std::fs::File::options().write(true).open(home.join(".omp/agent/sessions/-w/old.jsonl")).unwrap();
        old.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(40 * 86400)).unwrap();

        let out = std::process::Command::new(sh).arg("-c").arg(SCRIPT).env("HOME", &home).env_remove("CLAUDE_CONFIG_DIR").env_remove("CODEX_HOME").env_remove("PI_CODING_AGENT_DIR").output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.lines().all(|l| l.len() <= 2002), "lines are cut short");
        let s = parse("@local", &text);
        let _ = std::fs::remove_dir_all(&home);
        let by = |h: Harness| s.iter().find(|s| s.harness == h).unwrap_or_else(|| panic!("no {h:?} in {s:#?}\n{text}"));
        assert_eq!(s.len(), 3, "{s:#?}");
        let c = by(Harness::Claude);
        assert_eq!((c.id.as_str(), c.cwd.as_str(), c.title.as_deref()), (id, "/w/app", Some("Dark mode")));
        assert_eq!((c.first_prompt.as_deref(), c.last_prompt.as_deref()), (Some("Add a dark mode toggle"), Some("remember the choice")));
        let x = by(Harness::Codex);
        assert_eq!((x.id.as_str(), x.cwd.as_str(), x.title.as_deref()), (codex, "/w/api", Some("Flaky login")));
        assert_eq!((x.first_prompt.as_deref(), x.last_prompt.as_deref()), (Some("Why does it flake?"), Some("add a retry")));
        let p = by(Harness::Pi);
        assert_eq!((p.cwd.as_str(), p.title.as_deref(), p.last_prompt.as_deref()), ("/w/my site", Some("Notes"), Some("Write the notes")));
        assert!(p.resume.ends_with("--w-my site--/2026-10-18T08-00-00-000Z_7d1e0000-aaaa-4bbb-8ccc-dddddddddddd.jsonl"), "{}", p.resume);
    }
}

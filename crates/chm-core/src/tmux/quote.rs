//! Quoting for tmux command lines sent over control mode.
//!
//! tmux's parser treats `;`, `{`, `}`, `#`, `$`, `~` and whitespace specially. Single quotes
//! are fully literal but can't contain `'` or be used for newlines, so we fall back to double
//! quotes with escapes (`\\`, `\"`, `\$`, `\n`, `\r`, `\t`, `\ooo`), where a leading `~` or
//! `$VAR` would otherwise expand. A control-mode command line must never contain a raw
//! newline (it would end the command; an empty line detaches the client).
//!
//! `%` and `:` are deliberately not "bare-safe": tmux 3.4 rejects an unquoted `%0:off`
//! with a syntax error (the lexer treats leading `%` specially), while `'%0:off'` works.

fn is_bare_safe(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'/' | b'@' | b'=' | b'+' | b',')
}

/// Quotes one argument for a tmux command line.
pub fn quote(arg: &str) -> String {
    if !arg.is_empty() && arg.bytes().all(is_bare_safe) {
        return arg.to_string();
    }
    if !arg.contains('\'') && !arg.bytes().any(|b| b < 0x20 || b == 0x7f) {
        return format!("'{arg}'");
    }
    let mut out = String::with_capacity(arg.len() + 8);
    out.push('"');
    for ch in arg.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '$' => out.push_str("\\$"),
            '~' => out.push_str("\\176"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\{:03o}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Builds a single tmux command from its words, quoting each one.
pub fn cmd<S: AsRef<str>>(words: &[S]) -> String {
    let mut out = String::new();
    for (i, w) in words.iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        out.push_str(&quote(w.as_ref()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// Minimal port of tmux's argument unquoting for the forms `quote` produces.
    fn unquote(s: &str) -> String {
        let b = s.as_bytes();
        match b.first() {
            Some(b'\'') => s[1..s.len() - 1].to_string(),
            Some(b'"') => {
                let inner = &b[1..b.len() - 1];
                let mut out: Vec<u8> = Vec::new();
                let mut i = 0;
                while i < inner.len() {
                    if inner[i] == b'\\' {
                        let n = inner[i + 1];
                        match n {
                            b'n' => out.push(b'\n'),
                            b'r' => out.push(b'\r'),
                            b't' => out.push(b'\t'),
                            b'0'..=b'7' => {
                                let v = u8::from_str_radix(std::str::from_utf8(&inner[i + 1..i + 4]).unwrap(), 8).unwrap();
                                out.push(v);
                                i += 4;
                                continue;
                            }
                            other => out.push(other),
                        }
                        i += 2;
                    } else {
                        out.push(inner[i]);
                        i += 1;
                    }
                }
                String::from_utf8(out).unwrap()
            }
            _ => s.to_string(),
        }
    }

    #[test]
    fn examples() {
        assert_eq!(quote("%12"), "'%12'");
        assert_eq!(quote("%0:off"), "'%0:off'");
        assert_eq!(quote("-t"), "-t");
        assert_eq!(quote("#{pane_id}"), "'#{pane_id}'");
        assert_eq!(quote("sub:%*:#{pane_title}"), "'sub:%*:#{pane_title}'");
        assert_eq!(quote(""), "''");
        assert_eq!(quote("it's $HOME\n"), "\"it's \\$HOME\\n\"");
        assert_eq!(quote("~/x"), "'~/x'");
        assert_eq!(quote("~'"), "\"\\176'\"");
        assert_eq!(cmd(&["send-keys", "-t", "%3", "-l", "a;b"]), "send-keys -t '%3' -l 'a;b'");
    }

    proptest! {
        #[test]
        fn roundtrips(s in "\\PC*|[\\x00-\\x1f'\"\\\\$~;#{} a-z]*") {
            let q = quote(&s);
            prop_assert!(!q.contains('\n'), "raw newline in {q:?}");
            prop_assert!(!q.is_empty());
            prop_assert_eq!(unquote(&q), s);
        }
    }
}

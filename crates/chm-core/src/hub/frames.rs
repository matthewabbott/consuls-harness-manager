//! Binary frames sent to the UI: `kind u8, pane_key u32 LE, len u32 LE, payload`.
//! Several frames may be concatenated in one message.

/// Styled-run snapshot of a pane's visible screen (see [`crate::term::TileTerm::snapshot`]).
pub const TILE: u8 = 1;
/// Raw pane output for panes the UI is rendering with a full terminal emulator.
pub const RAW: u8 = 2;
/// Bytes that rebuild a streaming pane from scratch (full history seed); the UI resets its
/// terminal before writing them.
pub const RESET: u8 = 3;

pub fn encode(kind: u8, key: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 9);
    out.push(kind);
    out.extend_from_slice(&key.to_le_bytes());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn layout() {
        assert_eq!(super::encode(2, 0x0102_0304, b"hi"), vec![2, 4, 3, 2, 1, 2, 0, 0, 0, b'h', b'i']);
    }
}

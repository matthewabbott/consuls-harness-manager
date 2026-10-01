//! Builds the phone web app (`dist-web/`, from `npm run build:web`) into the binary. Without it,
//! a placeholder page says how to build it, so `cargo build` never needs npm.

use std::fmt::Write;
use std::path::{Path, PathBuf};

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../dist-web");
    println!("cargo:rerun-if-changed={}", root.display());
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let mut files = Vec::new();
    if root.join("index.html").is_file() {
        collect(&root, &root, &mut files);
    } else {
        let page = out.join("placeholder.html");
        std::fs::write(
            &page,
            "<!doctype html><meta name=viewport content='width=device-width'><title>Consuls</title>\
             <p style='font:16px system-ui;padding:2em'>The Consuls server runs, but its web app wasn't built in.\
             Run <code>npm run build:web</code>, then rebuild the server.</p>",
        )
        .unwrap();
        files.push(("index.html".to_string(), page));
    }
    files.sort();
    let mut code = String::from("pub static ASSETS: &[(&str, &[u8])] = &[\n");
    for (name, path) in &files {
        writeln!(code, "    ({name:?}, include_bytes!({:?})),", path.canonicalize().unwrap()).unwrap();
    }
    code.push_str("];\n");
    std::fs::write(out.join("web_assets.rs"), code).unwrap();
}

fn collect(root: &Path, dir: &Path, files: &mut Vec<(String, PathBuf)>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        println!("cargo:rerun-if-changed={}", path.display());
        if path.is_dir() {
            collect(root, &path, files);
        } else {
            let name = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            files.push((name, path));
        }
    }
}

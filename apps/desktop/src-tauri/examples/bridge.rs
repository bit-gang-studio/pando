//! Dev-only test bridge: serves the desktop app's real commands over HTTP so
//! browser tests can drive the real frontend against real git. Generated
//! from lib.rs. Never ships. Run with PANDO_CONFIG_DIR pointing at a throwaway
//! folder so it only ever sees test repos. Terminal, file watching and gh are
//! stubbed: nothing opens on screen and nothing talks to GitHub.
//!
//! cargo run -p pando-desktop --example bridge -- <port>

use pando_desktop_lib::dev_bridge::dispatch;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;

fn main() {
    let port = std::env::args().nth(1).unwrap_or_else(|| "4599".into());
    let listener = TcpListener::bind(format!("127.0.0.1:{port}")).expect("bind");
    eprintln!("bridge on {port}");
    for stream in listener.incoming().flatten() {
        std::thread::spawn(move || {
            let mut r = BufReader::new(&stream);
            let (mut line, mut first, mut len) = (String::new(), String::new(), 0usize);
            loop {
                line.clear();
                if r.read_line(&mut line).unwrap_or(0) == 0 {
                    return;
                }
                if first.is_empty() {
                    first = line.clone();
                }
                if line == "\r\n" {
                    break;
                }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0; len];
            let _ = r.read_exact(&mut body);
            let payload = if first.starts_with("OPTIONS") {
                String::new()
            } else {
                let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let cmd = req
                    .get("cmd")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
                let args = req.get("args").cloned().unwrap_or(Value::Null);
                match tauri::async_runtime::block_on(dispatch(&cmd, args)) {
                    Ok(v) => serde_json::json!({ "ok": v }).to_string(),
                    Err(e) => serde_json::json!({ "err": e }).to_string(),
                }
            };
            let mut s = &stream;
            let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len());
        });
    }
}

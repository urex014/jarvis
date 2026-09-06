use std::fs;
use std::io::{BufRead, BufReader};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{Emitter, Manager};

const SOCKET_PATH: &str = "/tmp/jarvis.sock";

fn get_voice_script_path() -> PathBuf {
    if let Ok(cwd) = std::env::current_dir() {
        let local_script = cwd.join("scripts/voice_route.sh");
        if local_script.exists() {
            return local_script;
        }
    }
    PathBuf::from("/home/cryptic/projects/jarvis/scripts/voice_route.sh")
}

fn trigger_voice_routing() {
    let script = get_voice_script_path();
    if script.exists() {
        let _ = Command::new("bash")
            .arg(script)
            .arg("start")
            .spawn();
    }
}

fn handle_incoming_ipc(app_handle: &tauri::AppHandle, line: &str) {
    let payload: serde_json::Value = serde_json::from_str(line.trim()).unwrap_or_else(|_| {
        serde_json::json!({
            "event": "wake_word",
            "phrase": "jarvis"
        })
    });

    let phrase = payload
        .get("phrase")
        .and_then(|p| p.as_str())
        .unwrap_or("jarvis");

    // 1. Show and focus window
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.emit(
            "wake-word-detected",
            serde_json::json!({
                "phrase": phrase,
                "timestamp": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            }),
        );
    }

    // 2. Trigger voice capture and routing
    trigger_voice_routing();
}

#[tauri::command]
fn hide_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn trigger_wake_word(app_handle: tauri::AppHandle, phrase: Option<String>) -> Result<(), String> {
    let phrase_str = phrase.unwrap_or_else(|| "jarvis".to_string());
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.emit(
            "wake-word-detected",
            serde_json::json!({
                "phrase": phrase_str,
                "timestamp": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            }),
        );
    }
    trigger_voice_routing();
    Ok(())
}

#[tauri::command]
fn trigger_voice_route() -> Result<String, String> {
    trigger_voice_routing();
    Ok("Voice routing script dispatched".to_string())
}

#[tauri::command]
fn get_voice_status() -> Result<String, String> {
    let state_file = Path::new("/tmp/jarvis_voice_state");
    if state_file.exists() {
        fs::read_to_string(state_file)
            .map(|s| s.trim().to_string())
            .map_err(|e| e.to_string())
    } else {
        Ok("IDLE".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Spawn background thread to listen on Unix domain socket for wake-word daemon
            std::thread::spawn(move || {
                let socket_path = Path::new(SOCKET_PATH);
                if socket_path.exists() {
                    let _ = fs::remove_file(socket_path);
                }

                if let Ok(listener) = UnixListener::bind(socket_path) {
                    for stream in listener.incoming() {
                        if let Ok(stream) = stream {
                            let mut reader = BufReader::new(stream);
                            let mut line = String::new();
                            if reader.read_line(&mut line).is_ok() && !line.is_empty() {
                                handle_incoming_ipc(&app_handle, &line);
                            }
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hide_window,
            trigger_wake_word,
            trigger_voice_route,
            get_voice_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

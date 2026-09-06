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
    let payload: serde_json::Value = match serde_json::from_str(line.trim()) {
        Ok(val) => val,
        Err(_) => return,
    };

    let event_type = payload.get("event").and_then(|e| e.as_str()).unwrap_or("");

    match event_type {
        "wake_word" => {
            let phrase = payload
                .get("phrase")
                .and_then(|p| p.as_str())
                .unwrap_or("jarvis");

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
            trigger_voice_routing();
        }
        "stt_partial" => {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.emit("stt-partial", payload);
            }
        }
        "stt_final" => {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.emit("stt-final", payload);
            }
        }
        "stt_state" => {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.emit("stt-state", payload);
            }
        }
        "command_handoff" => {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.emit("command-handoff", &payload);
                let _ = window.emit(
                    "agent-status",
                    serde_json::json!({
                        "status": "[Analyzing prompt & planning strategy...]",
                        "is_busy": true
                    }),
                );
            }
            if let Some(prompt) = payload.get("prompt").and_then(|p| p.as_str()) {
                let script = PathBuf::from("/home/cryptic/projects/jarvis/.venv/bin/python");
                let bridge = PathBuf::from("/home/cryptic/projects/jarvis/daemon/agy_bridge.py");
                if script.exists() && bridge.exists() {
                    let _ = Command::new(script)
                        .arg(bridge)
                        .arg("--prompt")
                        .arg(prompt)
                        .spawn();
                }
            }
        }
        "agent_status" => {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.emit("agent-status", payload);
            }
        }
        "agent_response" => {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.emit("agent-response", payload);
            }
        }
        "agent_delta" => {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.emit("agent-delta", payload);
            }
        }
        _ => {}
    }
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
fn stop_voice_route() -> Result<String, String> {
    let script = get_voice_script_path();
    if script.exists() {
        let _ = Command::new("bash")
            .arg(script)
            .arg("stop")
            .spawn();
    }
    Ok("Voice capture terminated".to_string())
}

#[tauri::command]
fn push_stt_token(
    app_handle: tauri::AppHandle,
    text: String,
    is_final: bool,
) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window("main") {
        let event_name = if is_final { "stt-final" } else { "stt-partial" };
        let _ = window.emit(
            event_name,
            serde_json::json!({
                "text": text,
                "timestamp": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            }),
        );
    }
    Ok(())
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

#[tauri::command]
fn submit_agy_prompt(app_handle: tauri::AppHandle, prompt: String) -> Result<String, String> {
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.emit(
            "agent-status",
            serde_json::json!({
                "status": "[Analyzing prompt & planning strategy...]",
                "prompt": &prompt,
                "is_busy": true
            }),
        );
    }

    let script = PathBuf::from("/home/cryptic/projects/jarvis/.venv/bin/python");
    let bridge = PathBuf::from("/home/cryptic/projects/jarvis/daemon/agy_bridge.py");
    if script.exists() && bridge.exists() {
        let _ = Command::new(script)
            .arg(bridge)
            .arg("--prompt")
            .arg(&prompt)
            .spawn();
    }
    Ok("Prompt forwarded to agy agent".to_string())
}

#[tauri::command]
fn simulate_agy_workflow(prompt: Option<String>) -> Result<String, String> {
    let script = PathBuf::from("/home/cryptic/projects/jarvis/.venv/bin/python");
    let bridge = PathBuf::from("/home/cryptic/projects/jarvis/daemon/agy_bridge.py");
    let p = prompt.unwrap_or_else(|| "Analyze repository state and status".to_string());
    if script.exists() && bridge.exists() {
        let _ = Command::new(script)
            .arg(bridge)
            .arg("--simulate")
            .arg(p)
            .spawn();
    }
    Ok("Simulated agy workflow initiated".to_string())
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
            stop_voice_route,
            push_stt_token,
            get_voice_status,
            submit_agy_prompt,
            simulate_agy_workflow
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

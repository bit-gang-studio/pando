//! Thin Tauri shell. All logic is in pando-core.

#[tauri::command]
fn version() -> &'static str {
    pando_core::VERSION
}

#[tauri::command]
fn doctor() -> pando_core::Doctor {
    pando_core::doctor()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![version, doctor])
        .run(tauri::generate_context!())
        .expect("failed to start Pando");
}

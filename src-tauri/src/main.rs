// Hides the extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(err) = fangce_lib::run() {
        eprintln!("方册 启动失败：{err}");
        std::process::exit(1);
    }
}

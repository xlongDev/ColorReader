// Hides the extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(err) = colorreader_lib::run() {
        eprintln!("ColorReader failed to start: {err}");
        std::process::exit(1);
    }
}

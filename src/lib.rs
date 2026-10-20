//! QuotaBar の使用量ロジック。GUI は Windows 専用（`ui`）。

pub mod format;
pub mod http;
pub mod model;
pub mod paths;
pub mod providers;
pub mod settings;

#[cfg(windows)]
mod ui;

pub fn run_app() {
    #[cfg(windows)]
    {
        if let Err(err) = ui::run() {
            eprintln!("QuotaBar failed: {err}");
            std::process::exit(1);
        }
    }
    #[cfg(not(windows))]
    {
        eprintln!(
            "QuotaBar is Windows-only. Build with --target x86_64-pc-windows-msvc or x86_64-pc-windows-gnu."
        );
        std::process::exit(1);
    }
}

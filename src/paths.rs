use std::fs;
use std::path::{Path, PathBuf};

pub fn env_value(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

/// Git Bash の `/c/Users/...` を Win32 が読める `C:/Users/...` にする。
pub fn native_home(raw: &str) -> String {
    let bytes = raw.as_bytes();
    if bytes.len() >= 3 && bytes[0] == b'/' && bytes[2] == b'/' {
        let drive = bytes[1] as char;
        if drive.is_ascii_alphabetic() {
            return format!("{}:{}", drive.to_ascii_uppercase(), &raw[2..]);
        }
    }
    if raw.len() >= 7 && raw.starts_with("/mnt/") {
        let drive = raw.as_bytes()[5] as char;
        if drive.is_ascii_alphabetic() && raw.as_bytes().get(6) == Some(&b'/') {
            return format!("{}:{}", drive.to_ascii_uppercase(), &raw[6..]);
        }
    }
    raw.to_string()
}

pub fn slash_path(value: &str) -> String {
    native_home(&value.replace('\\', "/"))
}

pub fn join_slash(parts: &[&str]) -> String {
    let mut out = String::new();
    for part in parts {
        if part.is_empty() {
            continue;
        }
        if out.is_empty() {
            out = slash_path(part);
            continue;
        }
        if out.ends_with('/') {
            out.push_str(&slash_path(part).trim_start_matches('/'));
        } else {
            out.push('/');
            out.push_str(&slash_path(part).trim_start_matches('/'));
        }
    }
    out
}

pub fn home_path() -> String {
    let profile = env_value("USERPROFILE");
    if !profile.is_empty() {
        return slash_path(&profile);
    }
    let home = env_value("HOME");
    if !home.is_empty() {
        return slash_path(&home);
    }
    slash_path(&std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into()))
}

pub fn roaming_root() -> String {
    let app_data = env_value("APPDATA");
    if !app_data.is_empty() {
        return slash_path(&app_data);
    }
    join_slash(&[&home_path(), "AppData", "Roaming"])
}

pub fn local_root() -> String {
    let local = env_value("LOCALAPPDATA");
    if !local.is_empty() {
        return slash_path(&local);
    }
    join_slash(&[&home_path(), "AppData", "Local"])
}

fn push_unique(out: &mut Vec<String>, path: String) {
    let normalized = slash_path(&path);
    if normalized.is_empty() || out.iter().any(|p| p == &normalized) {
        return;
    }
    out.push(normalized);
}

pub fn claude_cli_paths() -> Vec<String> {
    let mut out = Vec::new();
    let override_dir = env_value("CLAUDE_CONFIG_DIR");
    if !override_dir.is_empty() {
        push_unique(&mut out, join_slash(&[&override_dir, ".credentials.json"]));
        push_unique(&mut out, join_slash(&[&override_dir, "credentials.json"]));
    }
    let home = home_path();
    push_unique(&mut out, join_slash(&[&home, ".claude", ".credentials.json"]));
    push_unique(&mut out, join_slash(&[&home, ".claude", "credentials.json"]));
    out
}

pub fn claude_desktop_paths() -> Vec<String> {
    let mut out = Vec::new();
    let home = home_path();
    push_unique(
        &mut out,
        join_slash(&[&roaming_root(), "Claude", "config.json"]),
    );
    push_unique(&mut out, join_slash(&[&local_root(), "Claude", "config.json"]));
    push_unique(
        &mut out,
        join_slash(&[&home, "AppData", "Roaming", "Claude", "config.json"]),
    );
    push_unique(
        &mut out,
        join_slash(&[&home, "AppData", "Local", "Claude", "config.json"]),
    );
    let packages = join_slash(&[&local_root(), "Packages"]);
    if Path::new(&packages).is_dir() {
        if let Ok(entries) = fs::read_dir(&packages) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("Claude") {
                    push_unique(
                        &mut out,
                        join_slash(&[
                            &packages,
                            &name,
                            "LocalCache",
                            "Roaming",
                            "Claude",
                            "config.json",
                        ]),
                    );
                }
            }
        }
    }
    out
}

pub fn codex_paths() -> Vec<String> {
    let mut out = Vec::new();
    let override_dir = env_value("CODEX_HOME");
    if !override_dir.is_empty() {
        push_unique(&mut out, join_slash(&[&override_dir, "auth.json"]));
    }
    push_unique(&mut out, join_slash(&[&home_path(), ".codex", "auth.json"]));
    out
}

pub fn cursor_db_paths() -> Vec<String> {
    let mut out = Vec::new();
    let home = home_path();
    let brands = ["Cursor", "Cursor - Insiders"];
    let mut roots = Vec::new();
    push_unique(&mut roots, roaming_root());
    push_unique(&mut roots, local_root());
    push_unique(&mut roots, join_slash(&[&home, "AppData", "Roaming"]));
    push_unique(&mut roots, join_slash(&[&home, "AppData", "Local"]));
    for root in roots {
        for brand in brands {
            push_unique(
                &mut out,
                join_slash(&[&root, brand, "User", "globalStorage", "state.vscdb"]),
            );
        }
    }
    out
}

pub fn cursor_agent_paths() -> Vec<String> {
    let mut out = Vec::new();
    let home = home_path();
    push_unique(&mut out, join_slash(&[&roaming_root(), "cursor", "auth.json"]));
    push_unique(&mut out, join_slash(&[&local_root(), "cursor", "auth.json"]));
    push_unique(
        &mut out,
        join_slash(&[&home, "AppData", "Roaming", "cursor", "auth.json"]),
    );
    push_unique(&mut out, join_slash(&[&home, ".cursor", "auth.json"]));
    push_unique(&mut out, join_slash(&[&home, ".cursor-agent", "auth.json"]));
    out
}

pub fn existing_files(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .filter(|p| Path::new(p.as_str()).is_file())
        .cloned()
        .collect()
}

pub fn app_data_dir() -> PathBuf {
    PathBuf::from(join_slash(&[&roaming_root(), "QuotaBar"]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn git_bash_and_wsl_homes() {
        assert_eq!(native_home("/c/Users/me"), "C:/Users/me");
        assert_eq!(native_home("/mnt/c/Users/me"), "C:/Users/me");
        assert_eq!(native_home("C:\\Users\\me"), "C:\\Users\\me");
    }

    #[test]
    fn slash_normalizes_backslashes() {
        assert_eq!(slash_path("C:\\Users\\me\\AppData"), "C:/Users/me/AppData");
    }

    #[test]
    fn cursor_paths_include_roaming_and_profile() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("USERPROFILE", r"C:\Users\demo");
        std::env::set_var("APPDATA", r"C:\Users\demo\AppData\Roaming");
        std::env::remove_var("LOCALAPPDATA");
        let paths = cursor_db_paths();
        assert!(paths.iter().any(|p| p.ends_with("Cursor/User/globalStorage/state.vscdb")));
        assert!(paths.iter().any(|p| p.contains("Cursor - Insiders")));
        assert!(paths.iter().any(|p| p.contains("AppData/Local")));
    }

    #[test]
    fn claude_desktop_includes_roaming() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("APPDATA", r"C:\Users\demo\AppData\Roaming");
        std::env::set_var("LOCALAPPDATA", r"C:\Users\demo\AppData\Local");
        let paths = claude_desktop_paths();
        assert!(paths.iter().any(|p| p.ends_with("Claude/config.json")));
    }
}

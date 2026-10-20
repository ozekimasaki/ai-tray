use std::fs;
use std::io::Write;

use serde::{Deserialize, Serialize};

use crate::paths;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "default_true")]
    pub demo: bool,
    #[serde(default = "default_interval")]
    pub interval_sec: u32,
    #[serde(default = "default_true")]
    pub claude: bool,
    #[serde(default = "default_true")]
    pub codex: bool,
    #[serde(default = "default_true")]
    pub cursor: bool,
}

fn default_true() -> bool {
    true
}

fn default_interval() -> u32 {
    60
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            demo: true,
            interval_sec: 60,
            claude: true,
            codex: true,
            cursor: true,
        }
    }
}

impl Settings {
    pub fn load() -> Self {
        let path = paths::app_data_dir().join("settings.json");
        let Ok(text) = fs::read_to_string(path) else {
            return Self::default();
        };
        serde_json::from_str(&text).unwrap_or_default()
    }

    pub fn save(&self) {
        let dir = paths::app_data_dir();
        if fs::create_dir_all(&dir).is_err() {
            return;
        }
        let path = dir.join("settings.json");
        let Ok(text) = serde_json::to_string_pretty(self) else {
            return;
        };
        let tmp = dir.join("settings.json.tmp");
        if let Ok(mut file) = fs::File::create(&tmp) {
            let _ = file.write_all(text.as_bytes());
            let _ = fs::rename(tmp, path);
        }
    }

    pub fn from_state(state: &crate::model::AppState) -> Self {
        Self {
            demo: state.demo,
            interval_sec: state.interval_sec,
            claude: state.claude,
            codex: state.codex,
            cursor: state.cursor,
        }
    }
}

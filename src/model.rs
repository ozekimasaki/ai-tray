use crate::format::{count_tone, credits_label, format_reset, left_label, tone_for_used};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderId {
    Claude,
    Codex,
    Cursor,
}

impl ProviderId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Cursor => "cursor",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
            Self::Cursor => "Cursor",
        }
    }

    pub fn hint(self) -> &'static str {
        match self {
            Self::Claude => "Install the Claude app or Claude Code and sign in, then Refresh",
            Self::Codex => "Sign in with Codex CLI (auth.json), then Refresh",
            Self::Cursor => "Sign in to the Cursor app, or paste a cursor.com cookie",
        }
    }

    pub fn all() -> [ProviderId; 3] {
        [Self::Claude, Self::Codex, Self::Cursor]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Idle,
    Loading,
    Ready,
    Missing,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Normal,
    Warning,
    Destructive,
}

#[derive(Clone, Debug)]
pub struct Bar {
    pub title: String,
    pub used_percent: u32,
    pub resets_at_ms: i64,
    pub is_count: bool,
    pub remaining: u32,
}

impl Bar {
    pub fn used(title: impl Into<String>, used_percent: u32, resets_at_ms: i64) -> Self {
        Self {
            title: title.into(),
            used_percent: used_percent.min(100),
            resets_at_ms,
            is_count: false,
            remaining: 0,
        }
    }

    pub fn count(title: impl Into<String>, remaining: u32) -> Self {
        Self {
            title: title.into(),
            used_percent: 0,
            resets_at_ms: 0,
            is_count: true,
            remaining,
        }
    }

    pub fn left_percent(&self) -> u32 {
        if self.is_count {
            return 0;
        }
        100 - self.used_percent.min(100)
    }

    pub fn tone(&self) -> Tone {
        if self.is_count {
            count_tone(self.remaining)
        } else {
            tone_for_used(self.used_percent)
        }
    }

    pub fn value_label(&self) -> String {
        if self.is_count {
            credits_label(self.remaining)
        } else {
            left_label(self.used_percent)
        }
    }

    pub fn reset_label(&self, now_ms: i64) -> String {
        if self.is_count {
            "No reset".to_string()
        } else {
            format_reset(now_ms, self.resets_at_ms)
        }
    }
}

#[derive(Clone, Debug)]
pub struct ProviderCard {
    pub id: ProviderId,
    pub enabled: bool,
    pub plan: String,
    pub account: String,
    pub source: String,
    pub status: Status,
    pub error: String,
    pub stale: bool,
    pub bars: Vec<Bar>,
}

impl ProviderCard {
    pub fn idle(id: ProviderId, enabled: bool) -> Self {
        Self {
            id,
            enabled,
            plan: String::new(),
            account: String::new(),
            source: "auto".into(),
            status: Status::Idle,
            error: String::new(),
            stale: false,
            bars: Vec::new(),
        }
    }

    pub fn name(&self) -> &'static str {
        self.id.display_name()
    }

    pub fn hint(&self) -> &'static str {
        self.id.hint()
    }
}

#[derive(Clone, Debug)]
pub struct AppState {
    pub demo: bool,
    pub interval_sec: u32,
    pub last_refresh_ms: i64,
    pub fetching: bool,
    pub claude: bool,
    pub codex: bool,
    pub cursor: bool,
    pub providers: Vec<ProviderCard>,
}

impl AppState {
    pub fn new(settings: &crate::settings::Settings) -> Self {
        let mut state = Self {
            demo: settings.demo,
            interval_sec: settings.interval_sec,
            last_refresh_ms: 0,
            fetching: false,
            claude: settings.claude,
            codex: settings.codex,
            cursor: settings.cursor,
            providers: Vec::new(),
        };
        state.reset_cards();
        state
    }

    pub fn enabled(&self, id: ProviderId) -> bool {
        match id {
            ProviderId::Claude => self.claude,
            ProviderId::Codex => self.codex,
            ProviderId::Cursor => self.cursor,
        }
    }

    pub fn reset_cards(&mut self) {
        self.providers = ProviderId::all()
            .into_iter()
            .filter(|id| self.enabled(*id))
            .map(|id| ProviderCard::idle(id, true))
            .collect();
    }

    pub fn visible(&self) -> impl Iterator<Item = &ProviderCard> {
        self.providers.iter().filter(|p| p.enabled)
    }

    pub fn apply_demo(&mut self, now_ms: i64) {
        self.providers = demo_cards(now_ms)
            .into_iter()
            .filter(|p| self.enabled(p.id))
            .collect();
        self.last_refresh_ms = now_ms;
        self.fetching = false;
    }

    pub fn mark_loading(&mut self) {
        self.fetching = true;
        for p in &mut self.providers {
            if p.status == Status::Ready && !p.bars.is_empty() {
                p.stale = true;
            }
            p.status = Status::Loading;
            p.error.clear();
        }
    }

    pub fn apply_results(&mut self, now_ms: i64, results: Vec<ProviderCard>) {
        self.fetching = false;
        self.last_refresh_ms = now_ms;
        self.providers = results;
    }

    pub fn lowest_left_percent(&self) -> Option<u32> {
        self.providers
            .iter()
            .filter(|p| p.status == Status::Ready)
            .flat_map(|p| p.bars.iter())
            .filter(|b| !b.is_count)
            .map(|b| b.left_percent())
            .min()
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn demo_cards(now_ms: i64) -> Vec<ProviderCard> {
    let session = now_ms + (2 * 3600 + 14 * 60) * 1000;
    let weekly = now_ms + 3 * 24 * 3600 * 1000;
    let month = now_ms + 12 * 24 * 3600 * 1000;
    vec![
        ProviderCard {
            id: ProviderId::Claude,
            enabled: true,
            plan: "Pro".into(),
            account: "claude-code".into(),
            source: "auto".into(),
            status: Status::Ready,
            error: String::new(),
            stale: false,
            bars: vec![
                Bar::used("Session", 32, session),
                Bar::used("Weekly", 18, weekly),
            ],
        },
        ProviderCard {
            id: ProviderId::Codex,
            enabled: true,
            plan: "Plus".into(),
            account: "chatgpt".into(),
            source: "auto".into(),
            status: Status::Ready,
            error: String::new(),
            stale: false,
            bars: vec![
                Bar::used("Session (5h)", 71, session),
                Bar::used("Weekly (7d)", 24, weekly),
            ],
        },
        ProviderCard {
            id: ProviderId::Cursor,
            enabled: true,
            plan: "Pro".into(),
            account: "cursor-app".into(),
            source: "auto".into(),
            status: Status::Ready,
            error: String::new(),
            stale: false,
            bars: vec![
                Bar::used("Cursor", 12, month),
                Bar::used("Other", 44, month),
                Bar::used("Grok", 18, weekly),
            ],
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lowest_left_uses_quota_bars_only() {
        let mut state = AppState::new(&crate::settings::Settings::default());
        state.apply_demo(1_700_000_000_000);
        assert_eq!(state.lowest_left_percent(), Some(29));
    }
}

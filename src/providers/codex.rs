use serde_json::Value;

use crate::format::window_title;
use crate::http::{http_error_text, http_kind, request};
use crate::model::{Bar, ProviderCard, ProviderId};
use crate::paths::{codex_paths, existing_files};
use crate::providers::parse::{json_str, percent_from_window, reset_ms_from_window};
use crate::providers::{fail, ok, ErrorKind};

pub fn fetch(now_ms: i64) -> ProviderCard {
    let Some(token) = read_token() else {
        return fail(
            ProviderId::Codex,
            ErrorKind::NotFound,
            ProviderId::Codex.hint(),
        );
    };
    let res = request(
        "GET",
        "https://chatgpt.com/backend-api/wham/usage",
        &[
            ("Authorization", &format!("Bearer {token}")),
            ("Accept", "application/json"),
        ],
        None,
    );
    if !(200..300).contains(&res.status) {
        return fail(
            ProviderId::Codex,
            http_kind(res.status),
            http_error_text(res.status),
        );
    }
    parse_usage(&res.body, now_ms).unwrap_or_else(|| {
        fail(ProviderId::Codex, ErrorKind::Unknown, "Not found")
    })
}

fn read_token() -> Option<String> {
    for path in existing_files(&codex_paths()) {
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if let Some(tokens) = json.get("tokens") {
            if let Some(token) = json_str(tokens, &["access_token", "accessToken"]) {
                return Some(token.to_string());
            }
        }
        if let Some(token) = json_str(&json, &["access_token", "accessToken"]) {
            return Some(token.to_string());
        }
    }
    None
}

pub fn parse_usage(body: &str, now_ms: i64) -> Option<ProviderCard> {
    let json: Value = serde_json::from_str(body).ok()?;
    let rate = json.get("rate_limit");
    let primary = rate
        .and_then(|r| r.get("primary_window"))
        .or_else(|| json.get("primary_window"));
    let secondary = rate
        .and_then(|r| r.get("secondary_window"))
        .or_else(|| json.get("secondary_window"));
    let mut bars = Vec::new();
    if let Some(p) = percent_from_window(primary) {
        let seconds = primary.and_then(|w| w.get("limit_window_seconds").and_then(Value::as_f64));
        bars.push(Bar::used(
            window_title(seconds, "Primary"),
            p,
            reset_ms_from_window(primary, now_ms),
        ));
    }
    if let Some(s) = percent_from_window(secondary) {
        let seconds = secondary.and_then(|w| w.get("limit_window_seconds").and_then(Value::as_f64));
        bars.push(Bar::used(
            window_title(seconds, "Secondary"),
            s,
            reset_ms_from_window(secondary, now_ms),
        ));
    }
    if bars.is_empty() {
        return None;
    }
    let plan = json_str(&json, &["plan", "planType"]).unwrap_or("Codex");
    Some(ok(ProviderId::Codex, "chatgpt", plan, bars))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_wham_windows() {
        let body = r#"{
            "plan": "Plus",
            "rate_limit": {
                "primary_window": {"utilization": 0.71, "limit_window_seconds": 18000, "resets_at": "2026-01-01T00:00:00Z"},
                "secondary_window": {"used_percent": 24, "limit_window_seconds": 604800}
            }
        }"#;
        let card = parse_usage(body, 1_700_000_000_000).unwrap();
        assert_eq!(card.plan, "Plus");
        assert_eq!(card.bars[0].title, "Session (5h)");
        assert_eq!(card.bars[0].used_percent, 71);
        assert_eq!(card.bars[1].title, "Weekly (7d)");
        assert_eq!(card.bars[1].used_percent, 24);
    }
}

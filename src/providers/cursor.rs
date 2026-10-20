use std::fs;
use std::path::Path;

use base64::Engine;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::format::{clamp_percent_f64, parse_time_ms};
use crate::http::{http_error_text, http_kind, request};
use crate::model::{Bar, ProviderCard, ProviderId};
use crate::paths::{cursor_agent_paths, cursor_db_paths, existing_files};
use crate::providers::parse::{json_str, percent_from_display_message};
use crate::providers::{fail, ok, ErrorKind};

pub fn fetch(now_ms: i64) -> ProviderCard {
    let Some(cookie) = session_cookie(now_ms) else {
        return fail(
            ProviderId::Cursor,
            ErrorKind::NotFound,
            ProviderId::Cursor.hint(),
        );
    };
    let headers = [
        ("Cookie", cookie.as_str()),
        ("Accept", "application/json"),
        ("Origin", "https://cursor.com"),
        ("Referer", "https://cursor.com/dashboard"),
    ];
    let me = request("GET", "https://cursor.com/api/auth/me", &headers, None);
    if me.status == 401 || me.status == 403 {
        return fail(ProviderId::Cursor, ErrorKind::Auth, "Auth expired");
    }
    let account = serde_json::from_str::<Value>(&me.body)
        .ok()
        .and_then(|v| {
            json_str(&v, &["email", "email_address"]).map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| "cursor-app".into());
    let summary = request(
        "GET",
        "https://cursor.com/api/usage-summary",
        &headers,
        None,
    );
    if !(200..300).contains(&summary.status) {
        return fail(
            ProviderId::Cursor,
            http_kind(summary.status),
            http_error_text(summary.status),
        );
    }
    let Some(mut card) = parse_summary(&summary.body, &account, now_ms) else {
        return fail(ProviderId::Cursor, ErrorKind::Unknown, "Not found");
    };
    let sand = request(
        "POST",
        "https://cursor.com/api/dashboard/get-sand-usage-status",
        &headers,
        Some("{}"),
    );
    if (200..300).contains(&sand.status) {
        if let Some(bar) = parse_grok(&sand.body, now_ms) {
            card.bars.push(bar);
        }
    }
    if card.bars.is_empty() {
        return fail(ProviderId::Cursor, ErrorKind::Unknown, "Not found");
    }
    card
}

fn session_cookie(now_ms: i64) -> Option<String> {
    let token = read_token()?;
    let exp = jwt_exp_ms(&token);
    if exp > 0 && exp <= now_ms + 60_000 {
        return None;
    }
    Some(cookie_from_token(&token))
}

fn read_token() -> Option<String> {
    for db in existing_files(&cursor_db_paths()) {
        if let Some(token) = sqlite_token(&db) {
            return Some(token);
        }
        if let Some(token) = scan_cursor_jwt(&db) {
            return Some(token);
        }
    }
    for path in existing_files(&cursor_agent_paths()) {
        let Ok(text) = fs::read_to_string(path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if let Some(token) = json_str(&json, &["accessToken", "access_token"]) {
            return Some(token.to_string());
        }
    }
    None
}

fn sqlite_token(db_path: &str) -> Option<String> {
    let posix = db_path.replace('\\', "/");
    let sql = "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1";
    if let Some(token) = sqlite_query(&posix, sql) {
        return Some(token);
    }
    let tmp = std::env::temp_dir().join("quotabar-cursor-state.vscdb");
    if fs::copy(db_path, &tmp).is_ok() {
        let copied = sqlite_query(&tmp.to_string_lossy().replace('\\', "/"), sql);
        let _ = fs::remove_file(&tmp);
        return copied;
    }
    None
}

fn sqlite_query(posix: &str, sql: &str) -> Option<String> {
    let uri = format!("file:{posix}?mode=ro&immutable=1");
    let conn = Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .ok()?;
    let value: String = conn.query_row(sql, [], |row| row.get(0)).ok()?;
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

pub fn scan_cursor_jwt(db_path: &str) -> Option<String> {
    if !Path::new(db_path).is_file() {
        return None;
    }
    let bytes = fs::read(db_path).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let key = "cursorAuth/accessToken";
    let start = text.find(key).unwrap_or(0);
    let end = (start + 8000).min(text.len());
    let window = &text[start..end];
    let jwt_at = window.find("eyJ")?;
    let mut out = String::new();
    for ch in window[jwt_at..].chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        } else {
            break;
        }
    }
    if out.split('.').count() >= 2 && out.len() > 40 {
        Some(out)
    } else {
        None
    }
}

fn jwt_exp_ms(token: &str) -> i64 {
    let Some(payload) = token.split('.').nth(1) else {
        return 0;
    };
    let Some(json) = decode_jwt_json(payload) else {
        return 0;
    };
    json.get("exp")
        .and_then(Value::as_f64)
        .map(|exp| (exp * 1000.0) as i64)
        .unwrap_or(0)
}

fn cookie_from_token(token: &str) -> String {
    let Some(payload) = token.split('.').nth(1) else {
        return format!("WorkosCursorSessionToken={token}");
    };
    let Some(json) = decode_jwt_json(payload) else {
        return format!("WorkosCursorSessionToken={token}");
    };
    let sub = json.get("sub").and_then(Value::as_str).unwrap_or("");
    let user_id = sub.rsplit('|').next().unwrap_or("");
    if user_id.is_empty() {
        format!("WorkosCursorSessionToken={token}")
    } else {
        format!("WorkosCursorSessionToken={user_id}%3A%3A{token}")
    }
}

fn decode_jwt_json(payload: &str) -> Option<Value> {
    let mut b64 = payload.replace('-', "+").replace('_', "/");
    while b64.len() % 4 != 0 {
        b64.push('=');
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn parse_summary(body: &str, account: &str, now_ms: i64) -> Option<ProviderCard> {
    let json: Value = serde_json::from_str(body).ok()?;
    let plan_win = json
        .pointer("/individualUsage/plan")
        .or_else(|| json.get("planUsage"))
        .or_else(|| json.get("included"));
    let cycle = json_str(&json, &["billingCycleEnd", "billing_cycle_end"]).unwrap_or("");
    let cycle_ms = if cycle.is_empty() {
        0
    } else {
        parse_time_ms(cycle)
    };
    let mut cursor_pct = plan_win
        .and_then(|w| w.get("autoPercentUsed").and_then(Value::as_f64))
        .map(clamp_percent_f64);
    let mut other_pct = plan_win
        .and_then(|w| w.get("apiPercentUsed").and_then(Value::as_f64))
        .map(clamp_percent_f64);
    if cursor_pct.is_none() {
        cursor_pct = percent_from_display_message(json_str(&json, &["autoModelSelectedDisplayMessage"]));
    }
    if other_pct.is_none() {
        other_pct = percent_from_display_message(json_str(&json, &["namedModelSelectedDisplayMessage"]));
    }
    let mut bars = Vec::new();
    if let Some(pct) = cursor_pct {
        bars.push(Bar::used("Cursor", pct, cycle_ms));
    }
    if let Some(pct) = other_pct {
        bars.push(Bar::used("Other", pct, cycle_ms));
    }
    if bars.is_empty() {
        return None;
    }
    let plan = json_str(&json, &["plan", "planType"]).unwrap_or("Cursor");
    let _ = now_ms;
    Some(ok(ProviderId::Cursor, account, plan, bars))
}

fn parse_grok(body: &str, now_ms: i64) -> Option<Bar> {
    let json: Value = serde_json::from_str(body).ok()?;
    let has_limit = json
        .get("includedLimitZero")
        .and_then(Value::as_bool)
        .map(|zero| !zero)
        .or_else(|| json.get("hasNonZeroIncludedLimit").and_then(Value::as_bool));
    let trial_exp = json
        .get("sandTrialExpiresAt")
        .and_then(Value::as_str)
        .map(parse_time_ms)
        .unwrap_or(0);
    let trial_ok = trial_exp > now_ms;
    let has_trial = has_limit != Some(true) && trial_ok;
    if has_limit != Some(true) && !has_trial {
        return None;
    }
    let pct = json.get("usagePercent").and_then(Value::as_f64).map(clamp_percent_f64)?;
    let reset = if !has_trial {
        json.get("nextResetTimestampUtc")
            .and_then(Value::as_str)
            .map(parse_time_ms)
            .unwrap_or(0)
    } else {
        0
    };
    Some(Bar::used("Grok", pct, reset))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_usage_summary_pools() {
        let body = r#"{
            "plan": "Pro",
            "billingCycleEnd": "2026-02-01T00:00:00Z",
            "individualUsage": {"plan": {"autoPercentUsed": 12, "apiPercentUsed": 44}}
        }"#;
        let card = parse_summary(body, "a@b.com", 1_700_000_000_000).unwrap();
        assert_eq!(card.bars.len(), 2);
        assert_eq!(card.bars[0].title, "Cursor");
        assert_eq!(card.bars[0].used_percent, 12);
        assert_eq!(card.bars[1].used_percent, 44);
    }
}

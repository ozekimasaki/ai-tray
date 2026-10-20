use std::fs;
use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use serde_json::Value;

use crate::format::parse_time_ms;
use crate::http::{http_error_text, http_kind, request};
use crate::model::{Bar, ProviderCard, ProviderId};
use crate::paths::{claude_cli_paths, claude_desktop_paths, existing_files};
use crate::providers::parse::{json_str, percent_from_window, reset_ms_from_unix, reset_ms_from_window};
use crate::providers::{fail, ok, ErrorKind};

const CLAUDE_OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

pub fn fetch(now_ms: i64) -> ProviderCard {
    let mut from_cli = false;
    let mut token = claude_cli_token_fresh(now_ms);
    if !token.is_empty() {
        from_cli = true;
    }
    if token.is_empty() {
        token = read_desktop_token();
    }
    if token.is_empty() {
        token = claude_refreshed_token(now_ms);
        if !token.is_empty() {
            from_cli = true;
        }
    }
    if token.is_empty() {
        return fail(
            ProviderId::Claude,
            ErrorKind::NotFound,
            ProviderId::Claude.hint(),
        );
    }
    let from_desktop = !from_cli;
    let mut res = usage_request(&token);
    if (res.status == 401 || res.status == 403) && !from_desktop {
        let fresh = claude_refreshed_token(now_ms);
        if !fresh.is_empty() {
            let retried = usage_request(&fresh);
            if (200..300).contains(&retried.status) {
                res = retried;
            }
        }
    }
    if !(200..300).contains(&res.status) {
        return fail(
            ProviderId::Claude,
            http_kind(res.status),
            http_error_text(res.status),
        );
    }
    parse_usage(&res.body, now_ms, from_desktop).unwrap_or_else(|| {
        fail(ProviderId::Claude, ErrorKind::Unknown, "Not found")
    })
}

fn usage_request(token: &str) -> crate::http::HttpResult {
    request(
        "GET",
        "https://api.anthropic.com/api/oauth/usage",
        &[
            ("Authorization", &format!("Bearer {token}")),
            ("anthropic-beta", "oauth-2025-04-20"),
            ("Accept", "application/json"),
            ("User-Agent", "claude-code/2.1.0"),
        ],
        None,
    )
}

fn claude_cli_token_fresh(now_ms: i64) -> String {
    for path in existing_files(&claude_cli_paths()) {
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if let Some(token) = token_from_claude_json(&json) {
            let expiry = claude_expiry_ms(&json);
            if expiry > 0 && expiry <= now_ms + 60_000 {
                return String::new();
            }
            return token;
        }
    }
    String::new()
}

fn claude_refreshed_token(now_ms: i64) -> String {
    for path in existing_files(&claude_cli_paths()) {
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(oauth) = json.get("claudeAiOauth") else {
            continue;
        };
        let Some(rt) = json_str(oauth, &["refreshToken", "refresh_token"]) else {
            continue;
        };
        let until = oauth
            .get("refreshTokenExpiresAt")
            .or_else(|| oauth.get("refresh_token_expires_at"))
            .and_then(Value::as_f64)
            .map(|v| reset_ms_from_unix(v, 0))
            .unwrap_or(0);
        if until > 0 && until <= now_ms {
            continue;
        }
        let body = format!(
            "{{\"grant_type\":\"refresh_token\",\"refresh_token\":\"{rt}\",\"client_id\":\"{CLAUDE_OAUTH_CLIENT_ID}\"}}"
        );
        let res = request(
            "POST",
            "https://console.anthropic.com/v1/oauth/token",
            &[
                ("Content-Type", "application/json"),
                ("Accept", "application/json"),
            ],
            Some(&body),
        );
        if (200..300).contains(&res.status) {
            if let Ok(json) = serde_json::from_str::<Value>(&res.body) {
                if let Some(fresh) = json_str(&json, &["access_token", "accessToken"]) {
                    return fresh.to_string();
                }
            }
        }
    }
    String::new()
}

fn token_from_claude_json(json: &Value) -> Option<String> {
    if let Some(oauth) = json.get("claudeAiOauth") {
        if let Some(token) = json_str(oauth, &["accessToken", "access_token"]) {
            return Some(token.to_string());
        }
    }
    json_str(json, &["access_token", "accessToken"]).map(ToOwned::to_owned)
}

fn claude_expiry_ms(json: &Value) -> i64 {
    if let Some(oauth) = json.get("claudeAiOauth") {
        if let Some(raw) = oauth
            .get("expiresAt")
            .or_else(|| oauth.get("expiry_date"))
            .and_then(Value::as_f64)
        {
            return reset_ms_from_unix(raw, 0);
        }
    }
    json.get("expiry_date")
        .or_else(|| json.get("expiryDate"))
        .and_then(Value::as_f64)
        .map(|v| reset_ms_from_unix(v, 0))
        .unwrap_or(0)
}

fn read_desktop_token() -> String {
    for path in existing_files(&claude_desktop_paths()) {
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(cfg) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let blob = json_str(&cfg, &["oauth:tokenCacheV2", "oauth:tokenCache"]).unwrap_or("");
        if blob.is_empty() {
            continue;
        }
        if let Some(token) = inference_token_from_cache_object(blob) {
            return token;
        }
        if let Some(token) = decrypt_windows_token_cache(&path, blob) {
            return token;
        }
    }
    String::new()
}

fn inference_token_from_cache_object(text: &str) -> Option<String> {
    if let Ok(json) = serde_json::from_str::<Value>(text) {
        if let Some(token) = token_from_claude_json(&json) {
            return Some(token);
        }
    }
    if let Some(mark) = text.find("user:inference") {
        let window_end = (mark + 1200).min(text.len());
        let window = &text[mark..window_end];
        if let Some(token) = json_string_field(window, "token") {
            return Some(token);
        }
    }
    json_string_field(text, "token").filter(|t| t.starts_with("sk-ant-"))
}

fn json_string_field(text: &str, field: &str) -> Option<String> {
    let keys = [format!("\"{field}\":\""), format!("\"{field}\": \"")];
    for needle in keys {
        if let Some(at) = text.find(&needle) {
            let start = at + needle.len();
            let mut end = start;
            let bytes = text.as_bytes();
            while end < text.len() && bytes[end] != b'"' {
                if bytes[end] == b'\\' {
                    end += 1;
                }
                end += 1;
            }
            if end > start {
                return Some(text[start..end].to_string());
            }
        }
    }
    None
}

fn decrypt_windows_token_cache(config_path: &str, blob: &str) -> Option<String> {
    let dir = Path::new(config_path).parent()?;
    let local_state = fs::read_to_string(dir.join("Local State")).ok()?;
    let state: Value = serde_json::from_str(&local_state).ok()?;
    let enc = state
        .pointer("/os_crypt/encrypted_key")
        .and_then(Value::as_str)?;
    let raw = base64::engine::general_purpose::STANDARD.decode(enc).ok()?;
    if raw.len() <= 5 {
        return None;
    }
    let unprotected = dpapi_unprotect(&raw[5..])?;
    let plain = aes_gcm_decrypt(&unprotected, blob)?;
    inference_token_from_cache_object(&plain)
}

fn aes_gcm_decrypt(key: &[u8], blob_b64: &str) -> Option<String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(blob_b64)
        .ok()?;
    if raw.len() < 31 {
        return None;
    }
    let prefix = std::str::from_utf8(&raw[..3]).ok()?;
    if prefix != "v10" && prefix != "v20" {
        return None;
    }
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let nonce = Nonce::from_slice(&raw[3..15]);
    let mut payload = raw[15..raw.len() - 16].to_vec();
    payload.extend_from_slice(&raw[raw.len() - 16..]);
    let pt = cipher.decrypt(nonce, payload.as_ref()).ok()?;
    String::from_utf8(pt).ok()
}

#[cfg(windows)]
fn dpapi_unprotect(data: &[u8]) -> Option<Vec<u8>> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        CryptUnprotectData(&input, None, None, None, None, 0, &mut output).ok()?;
        let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let out = slice.to_vec();
        if !output.pbData.is_null() {
            let _ = LocalFree(HLOCAL(output.pbData as *mut core::ffi::c_void));
        }
        Some(out)
    }
}

#[cfg(not(windows))]
fn dpapi_unprotect(_data: &[u8]) -> Option<Vec<u8>> {
    None
}

pub fn parse_usage(body: &str, now_ms: i64, from_desktop: bool) -> Option<ProviderCard> {
    let json: Value = serde_json::from_str(body).ok()?;
    let mut bars = limit_bars(&json);
    if bars.is_empty() {
        if let Some(session) = percent_from_window(json.get("five_hour")) {
            bars.push(Bar::used(
                "Session",
                session,
                reset_ms_from_window(json.get("five_hour"), now_ms),
            ));
        }
        if let Some(weekly) = percent_from_window(json.get("seven_day")) {
            bars.push(Bar::used(
                "Weekly",
                weekly,
                reset_ms_from_window(json.get("seven_day"), now_ms),
            ));
        }
    }
    if bars.is_empty() {
        return None;
    }
    let account = if from_desktop {
        "claude-app"
    } else {
        "claude-code"
    };
    Some(ok(ProviderId::Claude, account, "Claude", bars))
}

fn limit_bars(json: &Value) -> Vec<Bar> {
    let Some(limits) = json.get("limits").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for limit in limits.iter().take(4) {
        let Some(pct) = limit.get("percent").and_then(Value::as_f64) else {
            continue;
        };
        if !pct.is_finite() {
            continue;
        }
        let reset = limit
            .get("resets_at")
            .and_then(Value::as_str)
            .map(parse_time_ms)
            .unwrap_or(0);
        out.push(Bar::used(limit_title(limit), crate::format::clamp_percent_f64(pct), reset));
    }
    out
}

fn limit_title(limit: &Value) -> String {
    if let Some(name) = limit
        .pointer("/scope/model/display_name")
        .and_then(Value::as_str)
    {
        if !name.is_empty() {
            return name.to_string();
        }
    }
    match limit.get("kind").and_then(Value::as_str).unwrap_or("") {
        "session" => "Session".into(),
        "weekly_all" | "weekly_scoped" => "Weekly".into(),
        "daily" => "Daily".into(),
        "hourly" => "Hourly".into(),
        other if !other.is_empty() => other.to_string(),
        _ => "Quota".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_limits_including_named_models() {
        let body = r#"{
            "limits": [
                {"kind": "session", "percent": 32, "resets_at": "2026-01-01T00:00:00Z"},
                {"kind": "weekly_scoped", "percent": 10, "scope": {"model": {"display_name": "Fable"}}}
            ]
        }"#;
        let card = parse_usage(body, 1, false).unwrap();
        assert_eq!(card.account, "claude-code");
        assert_eq!(card.bars[0].title, "Session");
        assert_eq!(card.bars[1].title, "Fable");
        assert_eq!(card.bars[1].used_percent, 10);
    }
}

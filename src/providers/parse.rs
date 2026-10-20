use serde_json::Value;

use crate::format::{clamp_percent_f64, parse_time_ms};

pub fn percent_from_window(w: Option<&Value>) -> Option<u32> {
    let w = w?;
    if let Some(v) = w.get("utilization").and_then(Value::as_f64) {
        return Some(clamp_percent_f64(if v <= 1.0 { v * 100.0 } else { v }));
    }
    if let Some(v) = w.get("used_percent").and_then(Value::as_f64) {
        return Some(clamp_percent_f64(v));
    }
    if let Some(v) = w.get("usedPercent").and_then(Value::as_f64) {
        return Some(clamp_percent_f64(v));
    }
    if let Some(v) = w.get("percent").and_then(Value::as_f64) {
        return Some(clamp_percent_f64(if v <= 1.0 { v * 100.0 } else { v }));
    }
    if let Some(v) = w.get("percentUsed").and_then(Value::as_f64) {
        return Some(clamp_percent_f64(if v <= 1.0 { v * 100.0 } else { v }));
    }
    let used = w.get("used").and_then(Value::as_f64);
    let limit = w.get("limit").and_then(Value::as_f64);
    if let (Some(used), Some(limit)) = (used, limit) {
        if limit > 0.0 {
            return Some(clamp_percent_f64((used / limit) * 100.0));
        }
    }
    None
}

pub fn reset_ms_from_unix(raw: f64, now_ms: i64) -> i64 {
    if raw > 1e12 {
        raw as i64
    } else if raw > 1e9 {
        (raw * 1000.0) as i64
    } else if raw > 0.0 {
        now_ms + (raw * 1000.0) as i64
    } else {
        0
    }
}

pub fn reset_ms_from_window(w: Option<&Value>, now_ms: i64) -> i64 {
    let Some(w) = w else {
        return 0;
    };
    if let Some(v) = w.get("reset_at").and_then(Value::as_f64) {
        return reset_ms_from_unix(v, now_ms);
    }
    if let Some(v) = w.get("resetAt").and_then(Value::as_f64) {
        return reset_ms_from_unix(v, now_ms);
    }
    if let Some(v) = w.get("resetInSec").and_then(Value::as_f64) {
        return now_ms + (v * 1000.0) as i64;
    }
    if let Some(iso) = w
        .get("resets_at")
        .and_then(Value::as_str)
        .or_else(|| w.get("resetsAt").and_then(Value::as_str))
    {
        return parse_time_ms(iso);
    }
    0
}

pub fn json_str<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    for key in keys {
        if let Some(s) = v.get(*key).and_then(Value::as_str) {
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    None
}

pub fn percent_from_display_message(message: Option<&str>) -> Option<u32> {
    let message = message?;
    let bytes = message.as_bytes();
    let pct = bytes.iter().position(|b| *b == b'%')?;
    if pct == 0 {
        return None;
    }
    let mut start = pct;
    while start > 0 {
        let b = bytes[start - 1];
        if !b.is_ascii_digit() && b != b'.' {
            break;
        }
        start -= 1;
    }
    if start == pct {
        return None;
    }
    message[start..pct].parse::<f64>().ok().map(clamp_percent_f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn utilization_fraction_and_used_limit() {
        let a = json!({"utilization": 0.32});
        assert_eq!(percent_from_window(Some(&a)), Some(32));
        let b = json!({"used": 25, "limit": 50});
        assert_eq!(percent_from_window(Some(&b)), Some(50));
    }

    #[test]
    fn display_message_percent() {
        assert_eq!(
            percent_from_display_message(Some("Auto: 12% used")),
            Some(12)
        );
    }
}

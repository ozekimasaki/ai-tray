use crate::model::Tone;

pub fn clamp_percent_f64(n: f64) -> u32 {
    if !n.is_finite() {
        return 0;
    }
    n.round().clamp(0.0, 100.0) as u32
}

pub fn tone_for_used(used_percent: u32) -> Tone {
    if used_percent > 90 {
        Tone::Destructive
    } else if used_percent > 50 {
        Tone::Warning
    } else {
        Tone::Normal
    }
}

pub fn count_tone(remaining: u32) -> Tone {
    if remaining == 0 {
        Tone::Destructive
    } else if remaining < 20 {
        Tone::Warning
    } else {
        Tone::Normal
    }
}

pub fn left_label(used_percent: u32) -> String {
    let used = used_percent.min(100);
    let left = if used >= 100 { 0 } else { 100 - used };
    format!("{left}% left")
}

pub fn credits_label(remaining: u32) -> String {
    format!("{remaining} credits")
}

pub fn format_ago(now_ms: i64, then_ms: i64) -> String {
    if then_ms <= 0 {
        return "Waiting for first refresh".into();
    }
    let delta = if now_ms < then_ms { 0 } else { now_ms - then_ms };
    let sec = delta / 1000;
    if sec < 5 {
        return "Updated just now".into();
    }
    if sec < 60 {
        return format!("Updated {sec}s ago");
    }
    let min = sec / 60;
    if min < 60 {
        return format!("Updated {min}m ago");
    }
    let hours = min / 60;
    format!("Updated {hours}h ago")
}

pub fn format_reset(now_ms: i64, resets_at_ms: i64) -> String {
    if resets_at_ms <= 0 {
        return String::new();
    }
    if resets_at_ms <= now_ms {
        return "Resets soon".into();
    }
    let sec = (resets_at_ms - now_ms) / 1000;
    if sec < 60 {
        return format!("Resets in {sec}s");
    }
    let min = sec / 60;
    if min < 60 {
        return format!("Resets in {min}m");
    }
    let hours = min / 60;
    let rem_min = min - hours * 60;
    if hours < 48 {
        return format!("Resets in {hours}h {rem_min}m");
    }
    let days = hours / 24;
    format!("Resets in {days}d")
}

pub fn window_title(seconds: Option<f64>, fallback: &str) -> String {
    let Some(seconds) = seconds else {
        return fallback.to_string();
    };
    if seconds <= 0.0 {
        return fallback.to_string();
    }
    if seconds <= 3600.0 {
        "Hourly".into()
    } else if seconds <= 18_000.0 {
        "Session (5h)".into()
    } else if seconds <= 86_400.0 {
        "Daily (24h)".into()
    } else if seconds <= 604_800.0 {
        "Weekly (7d)".into()
    } else if seconds <= 2_592_000.0 {
        "Monthly (30d)".into()
    } else {
        fallback.to_string()
    }
}

pub fn parse_time_ms(raw: &str) -> i64 {
    // RFC3339 / ISO-8601. 失敗したら 0。
    if let Ok(dt) = time_parse(raw) {
        return dt;
    }
    0
}

fn time_parse(raw: &str) -> Result<i64, ()> {
    // 依存を増やさないため、よく来る Z / オフセット付きを手で読む。
    let s = raw.trim();
    if s.len() < 19 {
        return Err(());
    }
    let year: i32 = s[0..4].parse().map_err(|_| ())?;
    let month: u32 = s[5..7].parse().map_err(|_| ())?;
    let day: u32 = s[8..10].parse().map_err(|_| ())?;
    let hour: u32 = s[11..13].parse().map_err(|_| ())?;
    let min: u32 = s[14..16].parse().map_err(|_| ())?;
    let sec: u32 = s[17..19].parse().map_err(|_| ())?;
    let mut offset_min: i32 = 0;
    if let Some(z) = s.find('Z').or_else(|| s.find('z')) {
        if z < 19 {
            return Err(());
        }
    } else if let Some(idx) = s.rfind('+').or_else(|| s[10..].rfind('-').map(|i| i + 10)) {
        if idx >= 19 {
            let rest = &s[idx + 1..];
            let oh: i32 = rest.get(0..2).unwrap_or("0").parse().unwrap_or(0);
            let om: i32 = rest.get(3..5).unwrap_or("0").parse().unwrap_or(0);
            let sign = if s.as_bytes().get(idx) == Some(&b'+') {
                1
            } else {
                -1
            };
            offset_min = sign * (oh * 60 + om);
        }
    }
    let days = days_from_civil(year, month, day)?;
    let total_sec = days * 86400 + i64::from(hour) * 3600 + i64::from(min) * 60 + i64::from(sec)
        - i64::from(offset_min) * 60;
    Ok(total_sec * 1000)
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Result<i64, ()> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(());
    }
    let mut y = year;
    let m = month as i32;
    y -= if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) as u32 + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Ok(i64::from(era) * 146097 + i64::from(doe) - 719468)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reset_empty_when_unknown() {
        assert_eq!(format_reset(1000, 0), "");
    }

    #[test]
    fn left_label_clamps() {
        assert_eq!(left_label(32), "68% left");
        assert_eq!(left_label(100), "0% left");
    }

    #[test]
    fn parses_rfc3339_z() {
        let ms = parse_time_ms("2026-01-02T03:04:05Z");
        assert!(ms > 0);
    }
}

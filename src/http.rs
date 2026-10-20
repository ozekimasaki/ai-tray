use std::io::Write;
use std::process::{Command, Stdio};

#[derive(Debug, Clone)]
pub struct HttpResult {
    pub status: u16,
    pub body: String,
}

/// Windows 10 以降の `curl.exe`（Linux のテストでは `curl`）。ureq の新しい idna 依存を避ける。
pub fn request(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&str>) -> HttpResult {
    let mut args: Vec<String> = vec![
        "-sS".into(),
        "-L".into(),
        "-m".into(),
        "20".into(),
        "-w".into(),
        "\n__STATUS__%{http_code}".into(),
        "-X".into(),
        method.to_string(),
    ];
    for (key, value) in headers {
        args.push("-H".into());
        args.push(format!("{key}: {value}"));
    }
    if body.is_some() {
        args.push("--data-binary".into());
        args.push("@-".into());
    }
    args.push(url.to_string());

    let mut child = match spawn_curl(&args) {
        Ok(child) => child,
        Err(err) => {
            return HttpResult {
                status: 0,
                body: err,
            };
        }
    };
    if let Some(body) = body {
        if let Some(stdin) = child.stdin.as_mut() {
            let _ = stdin.write_all(body.as_bytes());
        }
    }
    let output = match child.wait_with_output() {
        Ok(out) => out,
        Err(err) => {
            return HttpResult {
                status: 0,
                body: err.to_string(),
            };
        }
    };
    let combined = String::from_utf8_lossy(&output.stdout).into_owned();
    let marker = "\n__STATUS__";
    if let Some(at) = combined.rfind(marker) {
        let body = combined[..at].to_string();
        let status = combined[at + marker.len()..].trim().parse().unwrap_or(0);
        HttpResult { status, body }
    } else if output.status.success() {
        HttpResult {
            status: 0,
            body: combined,
        }
    } else {
        let err = String::from_utf8_lossy(&output.stderr).into_owned();
        HttpResult {
            status: 0,
            body: if err.is_empty() { combined } else { err },
        }
    }
}

fn spawn_curl(args: &[String]) -> Result<std::process::Child, String> {
    let names: &[&str] = if cfg!(windows) {
        &["curl.exe", "curl"]
    } else {
        &["curl"]
    };
    let mut last = "curl not found".to_string();
    for name in names {
        match Command::new(name)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => return Ok(child),
            Err(err) => last = err.to_string(),
        }
    }
    Err(last)
}

pub fn http_kind(status: u16) -> crate::providers::ErrorKind {
    match status {
        401 | 403 => crate::providers::ErrorKind::Auth,
        404 => crate::providers::ErrorKind::NotFound,
        0 => crate::providers::ErrorKind::Network,
        _ => crate::providers::ErrorKind::Unknown,
    }
}

pub fn http_error_text(status: u16) -> String {
    match status {
        401 | 403 => "Auth expired".into(),
        404 => "Not found".into(),
        429 => "Rate limited. Try again in a minute".into(),
        0 => "Network error".into(),
        n => format!("HTTP {n}"),
    }
}

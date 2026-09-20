// Windows / macOS / Linux の資格情報パス。秘密は返さない。
// 候補は OS 判定に頼らず全部列挙する。サービス子プロセスは APPDATA が落ちることがある。

import { homedir, platform } from "os";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import type { PathKind, PathRequest, PathResult } from "../snapshot.ts";

function encodePath(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function envValue(name: string): string {
  const value = process.env[name];
  if (value == null) return "";
  if (value.length === 0) return "";
  return value;
}

/** Git Bash の /c/Users/... を Win32 が読める C:/Users/... にする。 */
function nativeHome(raw: string): string {
  if (raw.length >= 3 && raw[0] === "/" && raw[2] === "/") {
    const drive = raw[1];
    const isLetter =
      (drive >= "a" && drive <= "z") || (drive >= "A" && drive <= "Z");
    if (isLetter) {
      return drive.toUpperCase() + ":" + raw.slice(2);
    }
  }
  if (raw.length >= 7 && raw.slice(0, 5) === "/mnt/") {
    const drive = raw[5];
    const isMntLetter =
      (drive >= "a" && drive <= "z") || (drive >= "A" && drive <= "Z");
    if (isMntLetter && raw[6] === "/") {
      return drive.toUpperCase() + ":" + raw.slice(6);
    }
  }
  return raw;
}

function slashPath(value: string): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch === "\\") out = out + "/";
    else out = out + ch;
    i = i + 1;
  }
  return nativeHome(out);
}

function homePath(): string {
  const profile = envValue("USERPROFILE");
  if (profile.length > 0) return slashPath(profile);
  const homeEnv = envValue("HOME");
  if (homeEnv.length > 0) return slashPath(homeEnv);
  const home = homedir();
  if (home.length === 0) return ".";
  return slashPath(home);
}

function looksWindows(): boolean {
  if (platform() === "win32") return true;
  if (platform() === "windows") return true;
  const osName = envValue("OS");
  if (osName.length >= 7) {
    const lower = osName.toLowerCase();
    if (lower.indexOf("windows") >= 0) return true;
  }
  if (envValue("WINDIR").length > 0) return true;
  if (envValue("SystemRoot").length > 0) return true;
  if (envValue("APPDATA").length > 0) return true;
  if (envValue("LOCALAPPDATA").length > 0) return true;
  return false;
}

function roamingRoot(): string {
  const appData = envValue("APPDATA");
  if (appData.length > 0) return slashPath(appData);
  return slashPath(join(homePath(), "AppData", "Roaming"));
}

function localRoot(): string {
  const local = envValue("LOCALAPPDATA");
  if (local.length > 0) return slashPath(local);
  return slashPath(join(homePath(), "AppData", "Local"));
}

function darwinSupport(): string {
  return slashPath(join(homePath(), "Library", "Application Support"));
}

function xdgConfig(): string {
  const xdg = envValue("XDG_CONFIG_HOME");
  if (xdg.length > 0) return slashPath(xdg);
  return slashPath(join(homePath(), ".config"));
}

function pushUnique(out: string[], path: string): void {
  const normalized = slashPath(path);
  if (normalized.length === 0) return;
  let i = 0;
  while (i < out.length) {
    if (out[i] === normalized) return;
    i = i + 1;
  }
  out.push(normalized);
}

function claudeCliPaths(): string[] {
  const out: string[] = [];
  const override = envValue("CLAUDE_CONFIG_DIR");
  if (override.length > 0) {
    pushUnique(out, join(slashPath(override), ".credentials.json"));
    pushUnique(out, join(slashPath(override), "credentials.json"));
  }
  const home = homePath();
  pushUnique(out, join(home, ".claude", ".credentials.json"));
  pushUnique(out, join(home, ".claude", "credentials.json"));
  return out;
}

function claudeDesktopConfigPaths(): string[] {
  const out: string[] = [];
  const home = homePath();
  pushUnique(out, join(roamingRoot(), "Claude", "config.json"));
  pushUnique(out, join(localRoot(), "Claude", "config.json"));
  pushUnique(out, join(home, "AppData", "Roaming", "Claude", "config.json"));
  pushUnique(out, join(home, "AppData", "Local", "Claude", "config.json"));
  const packagesDir = join(localRoot(), "Packages");
  if (existsSync(packagesDir)) {
    try {
      const names = readdirSync(packagesDir);
      let i = 0;
      while (i < names.length) {
        const name = names[i];
        if (name.indexOf("Claude") === 0) {
          pushUnique(
            out,
            join(packagesDir, name, "LocalCache", "Roaming", "Claude", "config.json"),
          );
        }
        i = i + 1;
      }
    } catch {
      // Packages が読めなくても他の候補を試す
    }
  }
  pushUnique(out, join(darwinSupport(), "Claude", "config.json"));
  pushUnique(out, join(xdgConfig(), "Claude", "config.json"));
  pushUnique(out, join(home, ".config", "Claude", "config.json"));
  return out;
}

function codexPaths(): string[] {
  const out: string[] = [];
  const override = envValue("CODEX_HOME");
  if (override.length > 0) {
    pushUnique(out, join(slashPath(override), "auth.json"));
  }
  const home = homePath();
  pushUnique(out, join(home, ".codex", "auth.json"));
  return out;
}

function cursorDbPaths(): string[] {
  const out: string[] = [];
  const home = homePath();
  const brands = ["Cursor", "Cursor - Insiders"];
  const roots: string[] = [];
  pushUnique(roots, roamingRoot());
  pushUnique(roots, localRoot());
  pushUnique(roots, join(home, "AppData", "Roaming"));
  pushUnique(roots, join(home, "AppData", "Local"));
  pushUnique(roots, darwinSupport());
  pushUnique(roots, xdgConfig());
  pushUnique(roots, join(home, ".config"));
  let r = 0;
  while (r < roots.length) {
    let b = 0;
    while (b < brands.length) {
      pushUnique(out, join(roots[r], brands[b], "User", "globalStorage", "state.vscdb"));
      b = b + 1;
    }
    r = r + 1;
  }
  return out;
}

function cursorAgentPaths(): string[] {
  const out: string[] = [];
  const home = homePath();
  pushUnique(out, join(roamingRoot(), "cursor", "auth.json"));
  pushUnique(out, join(localRoot(), "cursor", "auth.json"));
  pushUnique(out, join(home, "AppData", "Roaming", "cursor", "auth.json"));
  pushUnique(out, join(home, ".cursor", "auth.json"));
  pushUnique(out, join(home, ".cursor-agent", "auth.json"));
  pushUnique(out, join(darwinSupport(), "cursor", "auth.json"));
  pushUnique(out, join(xdgConfig(), "cursor", "auth.json"));
  pushUnique(out, join(home, ".config", "cursor", "auth.json"));
  return out;
}

function geminiPaths(): string[] {
  const out: string[] = [];
  const home = homePath();
  pushUnique(out, join(home, ".gemini", "oauth_creds.json"));
  if (looksWindows()) {
    pushUnique(out, join(roamingRoot(), "gemini", "oauth_creds.json"));
  }
  return out;
}

function candidates(kind: PathKind): string[] {
  if (kind === "claude") return claudeCliPaths();
  if (kind === "claude_desktop") return claudeDesktopConfigPaths();
  if (kind === "codex") return codexPaths();
  if (kind === "cursor") return cursorDbPaths();
  if (kind === "cursor_agent") return cursorAgentPaths();
  return geminiPaths();
}

function firstExistingOrCanonical(kind: PathKind): string {
  const list = candidates(kind);
  let i = 0;
  while (i < list.length) {
    if (existsSync(list[i])) return list[i];
    i = i + 1;
  }
  if (list.length > 0) return list[0];
  return "";
}

function joinCandidates(kind: PathKind): string {
  const list = candidates(kind);
  if (list.length === 0) return "";
  let out = list[0];
  let i = 1;
  while (i < list.length) {
    out = out + "\n" + list[i];
    i = i + 1;
  }
  return out;
}

/** usage.ts がファイル位置を解決する。コアからは呼ばない。先頭は存在する候補。 */
export function resolve(request: PathRequest): PathResult {
  return { kind: request.kind, path: encodePath(firstExistingOrCanonical(request.kind)) };
}

/** 改行区切りの候補一覧。存在しないパスも含む。 */
export function search(request: PathRequest): PathResult {
  return { kind: request.kind, path: encodePath(joinCandidates(request.kind)) };
}

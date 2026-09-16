// Windows と POSIX の資格情報パス。秘密は返さない。

import { homedir, platform } from "os";
import { join } from "path";
import type { PathRequest, PathResult } from "../snapshot.ts";

function encodePath(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function homePath(): string {
  const home = homedir();
  if (home.length === 0) return ".";
  return home;
}

function isWindows(): boolean {
  return platform() === "win32";
}

function envValue(name: string): string {
  const value = process.env[name];
  if (value == null) return "";
  if (value.length === 0) return "";
  return value;
}

function claudePath(): string {
  return join(homePath(), ".claude", ".credentials.json");
}

function codexPath(): string {
  const override = envValue("CODEX_HOME");
  if (override.length > 0) return join(override, "auth.json");
  return join(homePath(), ".codex", "auth.json");
}

function cursorPath(): string {
  if (isWindows()) {
    const appData = envValue("APPDATA");
    if (appData.length > 0) {
      return join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
    }
    return join(homePath(), "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  const xdg = envValue("XDG_CONFIG_HOME");
  if (xdg.length > 0) {
    return join(xdg, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return join(homePath(), ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

function geminiPath(): string {
  return join(homePath(), ".gemini", "oauth_creds.json");
}

/** usage.ts がファイル位置を解決する。コアからは呼ばない。 */
export function resolve(request: PathRequest): PathResult {
  if (request.kind === "claude") {
    return { kind: "claude", path: encodePath(claudePath()) };
  }
  if (request.kind === "codex") {
    return { kind: "codex", path: encodePath(codexPath()) };
  }
  if (request.kind === "cursor") {
    return { kind: "cursor", path: encodePath(cursorPath()) };
  }
  return { kind: "gemini", path: encodePath(geminiPath()) };
}

// 9 プロバイダの利用量を同期取得する。throw せず FetchOneResult を返す。

import { execFileSync } from "child_process";
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  AlibabaRegion,
  AuthSource,
  ErrorKind,
  FetchOneRequest,
  FetchOneResult,
  PathKind,
  ProviderId,
  QuotaWindow,
} from "../snapshot.ts";
import { search } from "./paths.ts";

const EMPTY = new Uint8Array(0);
// 公開リポジトリには実クライアントを載せない。Gemini CLI の refresh が必要なら手元で埋める。
const GEMINI_CLIENT_ID = "";
const GEMINI_CLIENT_SECRET = "";

type LooseWindow = {
  utilization?: number;
  used_percent?: number;
  usedPercent?: number;
  percent?: number;
  percentUsed?: number;
  resets_at?: string;
  reset_at?: number;
  resetsAt?: string;
  resetAt?: number;
  resetInSec?: number;
  used?: number;
  limit?: number;
  autoPercentUsed?: number;
  apiPercentUsed?: number;
};

type LooseJson = {
  claudeAiOauth?: { accessToken?: string; access_token?: string };
  tokens?: { access_token?: string; accessToken?: string };
  access_token?: string;
  accessToken?: string;
  refresh_token?: string;
  expiry_date?: number;
  expiryDate?: number;
  five_hour?: LooseWindow;
  seven_day?: LooseWindow;
  primary_window?: LooseWindow;
  secondary_window?: LooseWindow;
  rate_limit?: {
    primary_window?: LooseWindow;
    secondary_window?: LooseWindow;
  };
  plan?: string;
  planType?: string;
  email?: string;
  email_address?: string;
  individualUsage?: {
    plan?: LooseWindow;
  };
  planUsage?: LooseWindow;
  included?: LooseWindow;
  autoModelSelectedDisplayMessage?: string;
  namedModelSelectedDisplayMessage?: string;
  billingCycleEnd?: string;
  billing_cycle_end?: string;
  usagePercent?: number;
  hasNonZeroIncludedLimit?: boolean;
  includedLimitZero?: boolean;
  sandTrialExpiresAt?: string;
  nextResetTimestampUtc?: string;
  currentTier?: { id?: string };
  ineligibleTiers?: { reasonCode?: string }[];
  buckets?: { displayName?: string; remainingFraction?: number; remaining_fraction?: number }[];
  quotas?: LooseWindow[];
  rolling?: LooseWindow;
  weekly?: LooseWindow;
  monthly?: LooseWindow;
  rollingUsage?: LooseWindow;
  weeklyUsage?: LooseWindow;
  data?: LooseJson;
  usage?: LooseJson;
  remaining?: number;
  total?: number;
  code?: number;
  msg?: string;
  fiveHour?: LooseWindow;
  week?: LooseWindow;
  month?: LooseWindow;
  has_quota_allocation?: boolean;
  hide_daily_quota?: boolean;
  overage_balance?: number;
  daily_quota?: LooseWindow;
  weekly_quota?: LooseWindow;
  token?: string;
  refreshToken?: string;
  os_crypt?: { encrypted_key?: string };
  "oauth:tokenCacheV2"?: string;
  "oauth:tokenCache"?: string;
};

type HttpResult = {
  readonly status: number;
  readonly body: string;
};

function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function encodeText(value: string): Uint8Array {
  if (value.length === 0) return EMPTY;
  return new TextEncoder().encode(value);
}

/** application/x-www-form-urlencoded。encodeURIComponent に頼らない。 */
function formEncode(value: string): string {
  const utf8 = new TextEncoder().encode(value);
  const hex = "0123456789ABCDEF";
  let out = "";
  let i = 0;
  while (i < utf8.length) {
    const b = utf8[i];
    const unreserved =
      (b >= 48 && b <= 57) ||
      (b >= 65 && b <= 90) ||
      (b >= 97 && b <= 122) ||
      b === 45 ||
      b === 46 ||
      b === 95 ||
      b === 126;
    if (unreserved) {
      out = out + String.fromCharCode(b);
    } else {
      out = out + "%" + hex[b >> 4] + hex[b & 15];
    }
    i = i + 1;
  }
  return out;
}

function fail(id: ProviderId, nowMs: number, kind: ErrorKind, text: string): FetchOneResult {
  return {
    ok: false,
    id: id,
    account: EMPTY,
    plan: EMPTY,
    windows: { items: [] },
    errorKind: kind,
    errorText: encodeText(text),
    fetchedAtMs: nowMs,
  };
}

function okResult(
  id: ProviderId,
  nowMs: number,
  account: string,
  plan: string,
  windows: QuotaWindow[],
): FetchOneResult {
  return {
    ok: true,
    id: id,
    account: encodeText(account),
    plan: encodeText(plan),
    windows: { items: windows },
    errorKind: "none",
    errorText: EMPTY,
    fetchedAtMs: nowMs,
  };
}

function clampPercent(n: number): number {
  if (n !== n) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

function percentFromWindow(w: LooseWindow | undefined): number {
  if (w == null) return -1;
  if (w.utilization != null) return clampPercent(w.utilization <= 1 ? w.utilization * 100 : w.utilization);
  if (w.used_percent != null) return clampPercent(w.used_percent);
  if (w.usedPercent != null) return clampPercent(w.usedPercent);
  if (w.percent != null) return clampPercent(w.percent <= 1 ? w.percent * 100 : w.percent);
  if (w.percentUsed != null) return clampPercent(w.percentUsed <= 1 ? w.percentUsed * 100 : w.percentUsed);
  if (w.used != null && w.limit != null && w.limit > 0) {
    return clampPercent((w.used / w.limit) * 100);
  }
  return -1;
}

/** display message の `%` 直前の数字。正規表現は使わない。 */
function percentFromDisplayMessage(message: string | undefined): number {
  if (message == null || message.length === 0) return -1;
  const bytes = new TextEncoder().encode(message);
  let pct = -1;
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] === 37) {
      pct = i;
      break;
    }
    i = i + 1;
  }
  if (pct <= 0) return -1;
  let start = pct;
  while (start > 0) {
    const b = bytes[start - 1];
    const digit = b >= 48 && b <= 57;
    const dot = b === 46;
    if (!digit && !dot) break;
    start = start - 1;
  }
  if (start === pct) return -1;
  const n = Number(new TextDecoder().decode(bytes.slice(start, pct)));
  if (n !== n) return -1;
  return clampPercent(n);
}

function resetMsFromUnix(raw: number, nowMs: number): number {
  if (raw > 1e12) return raw;
  if (raw > 1e9) return raw * 1000;
  if (raw > 0) return nowMs + raw * 1000;
  return 0;
}

/** ISO / RFC3339 文字列を epoch ms にする。Date.parse は scriptc に無い。 */
function parseTimeMs(raw: string): number {
  const ms = new Date(raw).getTime();
  if (ms !== ms) return 0;
  return ms;
}

function resetMsFromWindow(w: LooseWindow | undefined, nowMs: number): number {
  if (w == null) return 0;
  if (w.reset_at != null) return resetMsFromUnix(w.reset_at, nowMs);
  if (w.resetAt != null) return resetMsFromUnix(w.resetAt, nowMs);
  if (w.resetInSec != null) return nowMs + w.resetInSec * 1000;
  const iso = w.resets_at ?? w.resetsAt;
  if (iso == null) return 0;
  return parseTimeMs(iso);
}

function bar(id: number, title: string, used: number, resetsAtMs: number): QuotaWindow {
  return {
    id: id,
    title: encodeText(title),
    usedPercent: clampPercent(used),
    resetsAtMs: resetsAtMs,
    isCount: false,
    remaining: 0,
  };
}

function countBar(id: number, title: string, remaining: number): QuotaWindow {
  const safeRemaining = remaining >= 0 && remaining <= 9007199254740991 ? Math.trunc(remaining) : 0;
  return {
    id: id,
    title: encodeText(title),
    usedPercent: 0,
    resetsAtMs: 0,
    isCount: true,
    remaining: safeRemaining,
  };
}

function readTextFile(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function parseJson(text: string): LooseJson | null {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as LooseJson;
  } catch {
    return null;
  }
}

function http(method: string, url: string, headers: string[], body: string): HttpResult {
  const args: string[] = ["-sS", "-L", "-m", "20", "-w", "\n__STATUS__%{http_code}", "-X", method];
  let i = 0;
  while (i < headers.length) {
    args.push("-H");
    args.push(headers[i]);
    i = i + 1;
  }
  if (body.length > 0) {
    args.push("--data-binary");
    args.push(body);
  }
  args.push(url);
  try {
    const out = execFileSync("curl", args, {
      encoding: "utf8",
      timeout: 21000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const marker = "\n__STATUS__";
    const at = out.lastIndexOf(marker);
    if (at < 0) return { status: 0, body: out };
    const bodyText = out.slice(0, at);
    const statusText = out.slice(at + marker.length);
    const status = Number(statusText);
    return { status: status, body: bodyText };
  } catch (e) {
    if (e instanceof Error) {
      return { status: 0, body: e.message };
    }
    return { status: 0, body: "Network error" };
  }
}

function httpKind(status: number): ErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 0) return "network";
  return "unknown";
}

function httpErrorText(status: number): string {
  if (status === 401 || status === 403) return "Auth expired";
  if (status === 404) return "Not found";
  if (status === 0) return "Network error";
  return "Network error";
}

function pathsFor(kind: PathKind): string[] {
  const raw = decodeBytes(search({ kind: kind }).path);
  const out: string[] = [];
  if (raw.length === 0) return out;
  const parts = raw.split("\n");
  let i = 0;
  while (i < parts.length) {
    const row = parts[i].trim();
    if (row.length > 0) out.push(row);
    i = i + 1;
  }
  return out;
}

function runTool(command: string, args: string[], timeoutMs: number): string {
  try {
    const out = execFileSync(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    return out.trim();
  } catch {
    return "";
  }
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
  return out;
}

function jwtExpMs(token: string): number {
  const parts = token.split(".");
  if (parts.length < 2) return 0;
  let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  while (payload.length % 4 !== 0) {
    payload = payload + "=";
  }
  try {
    const json = new TextDecoder().decode(Buffer.from(payload, "base64"));
    const parsed = JSON.parse(json) as { exp?: number };
    if (parsed.exp == null) return 0;
    return parsed.exp * 1000;
  } catch {
    return 0;
  }
}

function secretText(request: FetchOneRequest): string {
  return decodeBytes(request.secret).trim();
}

function looksLikeCookie(secret: string): boolean {
  return secret.indexOf("Cookie:") >= 0 || secret.indexOf("=") > 0;
}

function cookieHeader(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.toLowerCase().indexOf("cookie:") === 0) {
    return trimmed.slice(7).trim();
  }
  if (trimmed.indexOf("WorkosCursorSessionToken=") >= 0) return trimmed;
  if (trimmed.indexOf("=") < 0) return "WorkosCursorSessionToken=" + trimmed;
  return trimmed;
}

function tokenFromClaudeJson(file: LooseJson | null): string {
  if (file == null) return "";
  if (file.claudeAiOauth != null) {
    const token = file.claudeAiOauth.accessToken ?? file.claudeAiOauth.access_token;
    if (token != null && token.length > 0) return token;
  }
  if (file.access_token != null && file.access_token.length > 0) return file.access_token;
  if (file.accessToken != null && file.accessToken.length > 0) return file.accessToken;
  return "";
}

function jsonStringField(text: string, field: string): string {
  const keys = ["\"" + field + "\":\"", "\"" + field + "\": \""];
  let k = 0;
  while (k < keys.length) {
    const needle = keys[k];
    const at = text.indexOf(needle);
    if (at >= 0) {
      const start = at + needle.length;
      let end = start;
      while (end < text.length && text[end] !== "\"") {
        if (text[end] === "\\") end = end + 1;
        end = end + 1;
      }
      if (end > start) return text.slice(start, end);
    }
    k = k + 1;
  }
  return "";
}

function inferenceTokenFromCacheObject(text: string): string {
  if (text.length === 0) return "";
  const fromOauth = tokenFromClaudeJson(parseJson(text));
  if (fromOauth.length > 0) return fromOauth;
  const mark = text.indexOf("user:inference");
  if (mark >= 0) {
    const windowEnd = mark + 1200 < text.length ? mark + 1200 : text.length;
    const window = text.slice(mark, windowEnd);
    const token = jsonStringField(window, "token");
    if (token.length > 0) return token;
  }
  const anyToken = jsonStringField(text, "token");
  if (anyToken.indexOf("sk-ant-") === 0) return anyToken;
  return "";
}

function stripSingleQuotes(value: string): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    if (value[i] !== "'") out = out + value[i];
    i = i + 1;
  }
  return out;
}

function powershellUnprotect(b64: string): string {
  const script =
    "Add-Type -AssemblyName System.Security; " +
    "$b = [Convert]::FromBase64String('" +
    stripSingleQuotes(b64) +
    "'); " +
    "$p = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser'); " +
    "[Convert]::ToBase64String($p)";
  return runTool("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], 8000);
}

function nodeAesGcmDecrypt(keyB64: string, blobB64: string): string {
  const script =
    "const c=require('crypto');" +
    "const key=Buffer.from(process.argv[1],'base64');" +
    "const raw=Buffer.from(process.argv[2],'base64');" +
    "if(raw.length<31) process.exit(2);" +
    "const prefix=raw.slice(0,3).toString();" +
    "if(prefix!=='v10' && prefix!=='v20') process.exit(3);" +
    "const nonce=raw.slice(3,15);" +
    "const tag=raw.slice(raw.length-16);" +
    "const data=raw.slice(15,raw.length-16);" +
    "const d=c.createDecipheriv('aes-256-gcm',key,nonce);" +
    "d.setAuthTag(tag);" +
    "process.stdout.write(Buffer.concat([d.update(data),d.final()]).toString('utf8'));";
  const fromNode = runTool("node", ["-e", script, keyB64, blobB64], 8000);
  if (fromNode.length > 0) return fromNode;
  return runTool("node.exe", ["-e", script, keyB64, blobB64], 8000);
}

function windowsGcmDecrypt(keyB64: string, blobB64: string): string {
  const viaNode = nodeAesGcmDecrypt(keyB64, blobB64);
  if (viaNode.length > 0) return viaNode;
  const ps1 = join(tmpdir(), "quotabar-gcm.ps1");
  const body =
    "Add-Type -AssemblyName System.Security\n" +
    "Add-Type @\"\n" +
    "using System;\n" +
    "using System.Runtime.InteropServices;\n" +
    "public static class QbGcm {\n" +
    "  [StructLayout(LayoutKind.Sequential)]\n" +
    "  public struct Info {\n" +
    "    public int cbSize; public int dwInfoVersion;\n" +
    "    public IntPtr pbNonce; public int cbNonce;\n" +
    "    public IntPtr pbAuthData; public int cbAuthData;\n" +
    "    public IntPtr pbTag; public int cbTag;\n" +
    "    public IntPtr pbMacContext; public int cbMacContext;\n" +
    "    public int cbAAD; public long cbData; public int dwFlags;\n" +
    "  }\n" +
    "  [DllImport(\"bcrypt.dll\")] static extern int BCryptOpenAlgorithmProvider(out IntPtr a, [MarshalAs(UnmanagedType.LPWStr)] string n, string i, uint f);\n" +
    "  [DllImport(\"bcrypt.dll\")] static extern int BCryptSetProperty(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] string p, byte[] b, int c, uint f);\n" +
    "  [DllImport(\"bcrypt.dll\")] static extern int BCryptGenerateSymmetricKey(IntPtr a, out IntPtr k, IntPtr o, int oc, byte[] s, int sl, uint f);\n" +
    "  [DllImport(\"bcrypt.dll\")] static extern int BCryptDecrypt(IntPtr k, byte[] i, int il, ref Info p, byte[] iv, int ivl, byte[] o, int ol, out int r, uint f);\n" +
    "  [DllImport(\"bcrypt.dll\")] static extern int BCryptDestroyKey(IntPtr k);\n" +
    "  [DllImport(\"bcrypt.dll\")] static extern int BCryptCloseAlgorithmProvider(IntPtr a, uint f);\n" +
    "  public static byte[] Decrypt(byte[] key, byte[] nonce, byte[] cipher, byte[] tag) {\n" +
    "    IntPtr hAlg; IntPtr hKey;\n" +
    "    int st = BCryptOpenAlgorithmProvider(out hAlg, \"AES\", null, 0);\n" +
    "    if (st != 0) throw new Exception(\"open\");\n" +
    "    byte[] mode = System.Text.Encoding.Unicode.GetBytes(\"ChainingModeGCM\\0\");\n" +
    "    st = BCryptSetProperty(hAlg, \"ChainingMode\", mode, mode.Length, 0);\n" +
    "    st = BCryptGenerateSymmetricKey(hAlg, out hKey, IntPtr.Zero, 0, key, key.Length, 0);\n" +
    "    Info info = new Info();\n" +
    "    info.cbSize = Marshal.SizeOf(typeof(Info));\n" +
    "    info.dwInfoVersion = 1;\n" +
    "    info.pbNonce = Marshal.AllocHGlobal(nonce.Length);\n" +
    "    Marshal.Copy(nonce, 0, info.pbNonce, nonce.Length);\n" +
    "    info.cbNonce = nonce.Length;\n" +
    "    info.pbTag = Marshal.AllocHGlobal(tag.Length);\n" +
    "    Marshal.Copy(tag, 0, info.pbTag, tag.Length);\n" +
    "    info.cbTag = tag.Length;\n" +
    "    byte[] output = new byte[cipher.Length];\n" +
    "    int wrote;\n" +
    "    st = BCryptDecrypt(hKey, cipher, cipher.Length, ref info, null, 0, output, output.Length, out wrote, 0);\n" +
    "    Marshal.FreeHGlobal(info.pbNonce);\n" +
    "    Marshal.FreeHGlobal(info.pbTag);\n" +
    "    BCryptDestroyKey(hKey);\n" +
    "    BCryptCloseAlgorithmProvider(hAlg, 0);\n" +
    "    if (st != 0) throw new Exception(\"dec\");\n" +
    "    byte[] pt = new byte[wrote];\n" +
    "    Array.Copy(output, pt, wrote);\n" +
    "    return pt;\n" +
    "  }\n" +
    "  public static byte[] DecryptBlob(byte[] key, byte[] raw) {\n" +
    "    if (raw.Length < 31) throw new Exception(\"short\");\n" +
    "    byte[] nonce = new byte[12];\n" +
    "    Array.Copy(raw, 3, nonce, 0, 12);\n" +
    "    byte[] tag = new byte[16];\n" +
    "    Array.Copy(raw, raw.Length - 16, tag, 0, 16);\n" +
    "    int clen = raw.Length - 31;\n" +
    "    byte[] cipher = new byte[clen];\n" +
    "    Array.Copy(raw, 15, cipher, 0, clen);\n" +
    "    return Decrypt(key, nonce, cipher, tag);\n" +
    "  }\n" +
    "}\n" +
    "\"@\n" +
    "$key = [Convert]::FromBase64String('" +
    stripSingleQuotes(keyB64) +
    "')\n" +
    "$raw = [Convert]::FromBase64String('" +
    stripSingleQuotes(blobB64) +
    "')\n" +
    "$pt = [QbGcm]::DecryptBlob($key, $raw)\n" +
    "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($pt))\n";
  try {
    writeFileSync(ps1, body, "utf8");
    const out = runTool(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1],
      12000,
    );
    try {
      unlinkSync(ps1);
    } catch {
      // temp
    }
    return out;
  } catch {
    return "";
  }
}

function decryptWindowsTokenCache(configPath: string, blob: string): string {
  const dirEnd = configPath.lastIndexOf("/");
  const dir = dirEnd >= 0 ? configPath.slice(0, dirEnd) : configPath;
  const localState = readTextFile(join(dir, "Local State"));
  const state = parseJson(localState);
  let keyB64 = "";
  if (state != null && state.os_crypt != null) {
    const enc = state.os_crypt.encrypted_key ?? "";
    if (enc.length > 0) {
      const raw = Buffer.from(enc, "base64");
      if (raw.length > 5) {
        const dpapi = raw.slice(5);
        const unprotected = powershellUnprotect(dpapi.toString("base64"));
        if (unprotected.length > 0) keyB64 = unprotected;
      }
    }
  }
  if (keyB64.length > 0) {
    const plain = windowsGcmDecrypt(keyB64, blob);
    const fromObj = inferenceTokenFromCacheObject(plain);
    if (fromObj.length > 0) return fromObj;
  }
  const whole = powershellUnprotect(blob);
  if (whole.length > 0) {
    let decoded = whole;
    try {
      decoded = Buffer.from(whole, "base64").toString("utf8");
    } catch {
      decoded = whole;
    }
    const fromObj = inferenceTokenFromCacheObject(decoded);
    if (fromObj.length > 0) return fromObj;
  }
  return "";
}

function macosSafeStorageSecret(): string {
  const out = runTool("/usr/bin/security", ["find-generic-password", "-s", "Claude Safe Storage", "-w"], 8000);
  return out;
}

function opensslCbcDecrypt(keyHex: string, blobB64: string): string {
  const raw = Buffer.from(blobB64, "base64");
  if (raw.length < 20) return "";
  const prefix = raw.slice(0, 3).toString("utf8");
  if (prefix !== "v10") return "";
  const ct = raw.slice(3);
  const bin = join(tmpdir(), "quotabar-claude-ct.bin");
  try {
    writeFileSync(bin, ct);
    const out = runTool(
      "openssl",
      ["enc", "-aes-128-cbc", "-d", "-K", keyHex, "-iv", "20202020202020202020202020202020", "-in", bin],
      8000,
    );
    try {
      unlinkSync(bin);
    } catch {
      // temp
    }
    return out;
  } catch {
    return "";
  }
}

function pbkdf2KeyHex(secret: string, rounds: string): string {
  const py =
    "import hashlib,binascii,sys;" +
    "s=sys.argv[1].encode();" +
    "r=int(sys.argv[2]);" +
    "print(binascii.hexlify(hashlib.pbkdf2_hmac('sha1',s,b'saltysalt',r,16)).decode())";
  const tools = ["python3", "python", "py"];
  let t = 0;
  while (t < tools.length) {
    const args = tools[t] === "py" ? ["-3", "-c", py, secret, rounds] : ["-c", py, secret, rounds];
    const out = runTool(tools[t], args, 8000);
    if (out.length === 32) return out;
    t = t + 1;
  }
  return "";
}

function decryptMacLinuxTokenCache(blob: string): string {
  const macSecret = macosSafeStorageSecret();
  if (macSecret.length > 0) {
    const keyHex = pbkdf2KeyHex(macSecret, "1003");
    if (keyHex.length === 32) {
      const plain = opensslCbcDecrypt(keyHex, blob);
      const token = inferenceTokenFromCacheObject(plain);
      if (token.length > 0) return token;
    }
  }
  const linuxKey = pbkdf2KeyHex("peanuts", "1");
  if (linuxKey.length === 32) {
    const plain = opensslCbcDecrypt(linuxKey, blob);
    const token = inferenceTokenFromCacheObject(plain);
    if (token.length > 0) return token;
  }
  return "";
}

function readClaudeDesktopToken(): string {
  const configs = pathsFor("claude_desktop");
  let i = 0;
  while (i < configs.length) {
    const path = configs[i];
    if (!existsSync(path)) {
      i = i + 1;
      continue;
    }
    const cfg = parseJson(readTextFile(path));
    if (cfg == null) {
      i = i + 1;
      continue;
    }
    let blob = "";
    if (cfg["oauth:tokenCacheV2"] != null && cfg["oauth:tokenCacheV2"].length > 0) {
      blob = cfg["oauth:tokenCacheV2"];
    } else if (cfg["oauth:tokenCache"] != null && cfg["oauth:tokenCache"].length > 0) {
      blob = cfg["oauth:tokenCache"];
    }
    if (blob.length === 0) {
      i = i + 1;
      continue;
    }
    const asObj = inferenceTokenFromCacheObject(blob);
    if (asObj.length > 0) return asObj;
    const win = decryptWindowsTokenCache(path, blob);
    if (win.length > 0) return win;
    const unix = decryptMacLinuxTokenCache(blob);
    if (unix.length > 0) return unix;
    i = i + 1;
  }
  return "";
}

function readClaudeToken(source: AuthSource, secret: string): string {
  if (source === "cookie" || source === "api") return secret;
  const files = pathsFor("claude");
  let i = 0;
  while (i < files.length) {
    const token = tokenFromClaudeJson(parseJson(readTextFile(files[i])));
    if (token.length > 0) return token;
    i = i + 1;
  }
  const desktop = readClaudeDesktopToken();
  if (desktop.length > 0) return desktop;
  return secret;
}

function claudeAccountLabel(tokenFromDesktop: boolean): string {
  if (tokenFromDesktop) return "claude-app";
  return "claude-code";
}

function fetchClaude(request: FetchOneRequest): FetchOneResult {
  const secret = secretText(request);
  const cliFiles = pathsFor("claude");
  let hasCli = false;
  let c = 0;
  while (c < cliFiles.length) {
    if (tokenFromClaudeJson(parseJson(readTextFile(cliFiles[c]))).length > 0) hasCli = true;
    c = c + 1;
  }
  const token = readClaudeToken(request.source, secret);
  if (token.length === 0) {
    return fail(
      request.id,
      request.nowMs,
      "not_found",
      "Install the Claude app or Claude Code and sign in, then Refresh",
    );
  }
  const fromDesktop = !hasCli && secret.length === 0;
  const headers = [
    "Authorization: Bearer " + token,
    "anthropic-beta: oauth-2025-04-20",
    "Accept: application/json",
    "User-Agent: claude-code/2.1.0",
  ];
  let res = http("GET", "https://api.anthropic.com/api/oauth/usage", headers, "");
  if ((res.status === 401 || res.status === 403) && secret.length > 0 && looksLikeCookie(secret)) {
    res = http(
      "GET",
      "https://claude.ai/api/organizations",
      ["Cookie: " + cookieHeader(secret), "Accept: application/json"],
      "",
    );
    if (res.status < 200 || res.status >= 300) {
      return fail(request.id, request.nowMs, httpKind(res.status), httpErrorText(res.status));
    }
  }
  if (res.status < 200 || res.status >= 300) {
    return fail(request.id, request.nowMs, httpKind(res.status), httpErrorText(res.status));
  }
  const json = parseJson(res.body);
  if (json == null) return fail(request.id, request.nowMs, "unknown", "Network error");
  const windows: QuotaWindow[] = [];
  const session = percentFromWindow(json.five_hour);
  if (session >= 0) windows.push(bar(1, "Session", session, resetMsFromWindow(json.five_hour, request.nowMs)));
  const weekly = percentFromWindow(json.seven_day);
  if (weekly >= 0) windows.push(bar(2, "Weekly", weekly, resetMsFromWindow(json.seven_day, request.nowMs)));
  if (windows.length === 0) {
    return fail(request.id, request.nowMs, "unknown", "Not found");
  }
  return okResult(request.id, request.nowMs, claudeAccountLabel(fromDesktop), "Claude", windows);
}

function readCodexToken(source: AuthSource, secret: string): string {
  if (source === "api" || source === "cookie") return secret;
  const files = pathsFor("codex");
  let i = 0;
  while (i < files.length) {
    const file = parseJson(readTextFile(files[i]));
    if (file != null && file.tokens != null) {
      const token = file.tokens.access_token ?? file.tokens.accessToken;
      if (token != null && token.length > 0) return token;
    }
    if (file != null && file.access_token != null && file.access_token.length > 0) {
      return file.access_token;
    }
    i = i + 1;
  }
  return secret;
}

function fetchCodex(request: FetchOneRequest): FetchOneResult {
  const token = readCodexToken(request.source, secretText(request));
  if (token.length === 0) {
    return fail(request.id, request.nowMs, "not_found", "Sign in with Codex CLI (auth.json), then Refresh");
  }
  const res = http(
    "GET",
    "https://chatgpt.com/backend-api/wham/usage",
    ["Authorization: Bearer " + token, "Accept: application/json"],
    "",
  );
  if (res.status < 200 || res.status >= 300) {
    return fail(request.id, request.nowMs, httpKind(res.status), httpErrorText(res.status));
  }
  const json = parseJson(res.body);
  if (json == null) return fail(request.id, request.nowMs, "unknown", "Network error");
  const rate = json.rate_limit;
  const primary = rate != null ? rate.primary_window : json.primary_window;
  const secondary = rate != null ? rate.secondary_window : json.secondary_window;
  const windows: QuotaWindow[] = [];
  const p = percentFromWindow(primary);
  if (p >= 0) windows.push(bar(1, "Primary", p, resetMsFromWindow(primary, request.nowMs)));
  const s = percentFromWindow(secondary);
  if (s >= 0) windows.push(bar(2, "Secondary", s, resetMsFromWindow(secondary, request.nowMs)));
  if (windows.length === 0) return fail(request.id, request.nowMs, "unknown", "Not found");
  const plan = json.plan ?? json.planType ?? "Codex";
  return okResult(request.id, request.nowMs, "chatgpt", plan, windows);
}

function sqliteQuery(dbPath: string, sql: string): string {
  const posix = slashPath(dbPath);
  const tools = ["sqlite3", "sqlite3.exe"];
  let t = 0;
  while (t < tools.length) {
    const direct = runTool(tools[t], ["-readonly", "-noheader", posix, sql], 5000);
    if (direct.length > 0) return direct;
    const uri = "file:" + posix + "?mode=ro&immutable=1";
    const viaUri = runTool(tools[t], ["-readonly", "-noheader", uri, sql], 5000);
    if (viaUri.length > 0) return viaUri;
    t = t + 1;
  }
  const tmp = join(tmpdir(), "quotabar-cursor-state.vscdb");
  try {
    copyFileSync(dbPath, tmp);
    t = 0;
    while (t < tools.length) {
      const copied = runTool(tools[t], ["-readonly", "-noheader", slashPath(tmp), sql], 5000);
      if (copied.length > 0) {
        try {
          unlinkSync(tmp);
        } catch {
          // temp
        }
        return copied;
      }
      t = t + 1;
    }
    try {
      unlinkSync(tmp);
    } catch {
      // temp
    }
  } catch {
    // locked or missing sqlite3
  }
  const py =
    "import sqlite3,sys;" +
    "c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);" +
    "r=c.execute(sys.argv[2]).fetchone();" +
    "print(r[0] if r and r[0] is not None else '')";
  const pyTools = ["python3", "python", "py"];
  let p = 0;
  while (p < pyTools.length) {
    const args =
      pyTools[p] === "py" ? ["-3", "-c", py, posix, sql] : ["-c", py, posix, sql];
    const out = runTool(pyTools[p], args, 5000);
    if (out.length > 0) return out;
    p = p + 1;
  }
  return "";
}

function scanCursorJwt(dbPath: string): string {
  if (!existsSync(dbPath)) return "";
  let text = "";
  try {
    text = readFileSync(dbPath, "utf8");
  } catch {
    return "";
  }
  const key = "cursorAuth/accessToken";
  const at = text.indexOf(key);
  const start = at >= 0 ? at : 0;
  const end = start + 8000 < text.length ? start + 8000 : text.length;
  const window = text.slice(start, end);
  const jwtAt = window.indexOf("eyJ");
  if (jwtAt < 0) return "";
  let i = jwtAt;
  let out = "";
  while (i < window.length) {
    const ch = window[i];
    const ok =
      (ch >= "A" && ch <= "Z") ||
      (ch >= "a" && ch <= "z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "-" ||
      ch === "_" ||
      ch === ".";
    if (!ok) break;
    out = out + ch;
    i = i + 1;
  }
  const parts = out.split(".");
  if (parts.length >= 2 && out.length > 40) return out;
  return "";
}

function readCursorTokenFromDb(): string {
  const sql = "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1;";
  const dbs = pathsFor("cursor");
  let i = 0;
  while (i < dbs.length) {
    if (!existsSync(dbs[i])) {
      i = i + 1;
      continue;
    }
    const fromSql = sqliteQuery(dbs[i], sql);
    if (fromSql.length > 0) return fromSql;
    const scanned = scanCursorJwt(dbs[i]);
    if (scanned.length > 0) return scanned;
    i = i + 1;
  }
  const agents = pathsFor("cursor_agent");
  i = 0;
  while (i < agents.length) {
    const file = parseJson(readTextFile(agents[i]));
    if (file != null) {
      const token = file.accessToken ?? file.access_token;
      if (token != null && token.length > 0) return token;
    }
    i = i + 1;
  }
  return "";
}

function cursorCookie(request: FetchOneRequest): string {
  const secret = secretText(request);
  if (request.source === "cookie" || request.source === "api") {
    if (secret.length === 0) return "";
    return cookieHeader(secret);
  }
  if (secret.length > 0) return cookieHeader(secret);
  const token = readCursorTokenFromDb();
  if (token.length === 0) return "";
  const exp = jwtExpMs(token);
  if (exp > 0 && exp <= request.nowMs + 60000) return "";
  const payload = token.split(".");
  if (payload.length < 2) return "WorkosCursorSessionToken=" + token;
  try {
    let mid = payload[1].replace(/-/g, "+").replace(/_/g, "/");
    while (mid.length % 4 !== 0) mid = mid + "=";
    const json = JSON.parse(new TextDecoder().decode(Buffer.from(mid, "base64"))) as { sub?: string };
    const sub = json.sub ?? "";
    const parts = sub.split("|");
    const userId = parts.length > 0 ? parts[parts.length - 1] : "";
    if (userId.length === 0) return "WorkosCursorSessionToken=" + token;
    return "WorkosCursorSessionToken=" + userId + "%3A%3A" + token;
  } catch {
    return "WorkosCursorSessionToken=" + token;
  }
}

function fetchCursor(request: FetchOneRequest): FetchOneResult {
  const cookie = cursorCookie(request);
  if (cookie.length === 0) {
    return fail(
      request.id,
      request.nowMs,
      "not_found",
      "Sign in to the Cursor app, or paste a cursor.com cookie",
    );
  }
  const headers = [
    "Cookie: " + cookie,
    "Accept: application/json",
    "Origin: https://cursor.com",
    "Referer: https://cursor.com/dashboard",
  ];
  const me = http("GET", "https://cursor.com/api/auth/me", headers, "");
  if (me.status === 401 || me.status === 403) {
    return fail(request.id, request.nowMs, "auth", "Auth expired");
  }
  const meJson = parseJson(me.body);
  const account = meJson != null ? meJson.email ?? meJson.email_address ?? "cursor-app" : "cursor-app";
  const summary = http("GET", "https://cursor.com/api/usage-summary", headers, "");
  if (summary.status < 200 || summary.status >= 300) {
    return fail(request.id, request.nowMs, httpKind(summary.status), httpErrorText(summary.status));
  }
  const json = parseJson(summary.body);
  if (json == null) return fail(request.id, request.nowMs, "unknown", "Network error");
  const planWin = json.individualUsage != null ? json.individualUsage.plan : json.planUsage ?? json.included;
  const windows: QuotaWindow[] = [];
  const cycle = json.billingCycleEnd ?? json.billing_cycle_end;
  const cycleMs = cycle != null ? parseTimeMs(cycle) : 0;
  let cursorPct = -1;
  let otherPct = -1;
  if (planWin != null && planWin.autoPercentUsed != null) {
    cursorPct = clampPercent(planWin.autoPercentUsed);
  }
  if (planWin != null && planWin.apiPercentUsed != null) {
    otherPct = clampPercent(planWin.apiPercentUsed);
  }
  if (cursorPct < 0) cursorPct = percentFromDisplayMessage(json.autoModelSelectedDisplayMessage);
  if (otherPct < 0) otherPct = percentFromDisplayMessage(json.namedModelSelectedDisplayMessage);
  if (cursorPct >= 0) windows.push(bar(1, "Cursor", cursorPct, cycleMs));
  if (otherPct >= 0) windows.push(bar(2, "Other", otherPct, cycleMs));
  const sand = http("POST", "https://cursor.com/api/dashboard/get-sand-usage-status", headers, "{}");
  if (sand.status >= 200 && sand.status < 300) {
    const sandJson = parseJson(sand.body);
    if (sandJson != null) {
      let hasLimit: boolean | null = null;
      if (sandJson.includedLimitZero != null) {
        hasLimit = sandJson.includedLimitZero === false;
      } else if (sandJson.hasNonZeroIncludedLimit != null) {
        hasLimit = sandJson.hasNonZeroIncludedLimit === true;
      }
      const trialExp = sandJson.sandTrialExpiresAt != null ? parseTimeMs(sandJson.sandTrialExpiresAt) : 0;
      const trialOk = trialExp > request.nowMs;
      const hasTrial = hasLimit !== true && trialOk;
      if ((hasLimit === true || hasTrial) && sandJson.usagePercent != null) {
        let reset = 0;
        if (!hasTrial && sandJson.nextResetTimestampUtc != null) {
          reset = parseTimeMs(sandJson.nextResetTimestampUtc);
        }
        windows.push(bar(3, "Grok", sandJson.usagePercent, reset));
      }
    }
  }
  if (windows.length === 0) return fail(request.id, request.nowMs, "unknown", "Not found");
  const planName = json.plan ?? json.planType ?? "Cursor";
  return okResult(request.id, request.nowMs, account, planName, windows);
}

function geminiToken(request: FetchOneRequest): string {
  const secret = secretText(request);
  if (request.source === "api" || request.source === "cookie") return secret;
  let file: LooseJson | null = null;
  const files = pathsFor("gemini");
  let i = 0;
  while (i < files.length) {
    file = parseJson(readTextFile(files[i]));
    if (file != null) break;
    i = i + 1;
  }
  if (file == null) return secret;
  const expiry = file.expiry_date ?? file.expiryDate ?? 0;
  const access = file.access_token ?? "";
  if (access.length > 0 && (expiry === 0 || expiry > request.nowMs + 60000)) return access;
  const refresh = file.refresh_token ?? "";
  if (refresh.length === 0) return secret;
  const body =
    "client_id=" +
    formEncode(GEMINI_CLIENT_ID) +
    "&client_secret=" +
    formEncode(GEMINI_CLIENT_SECRET) +
    "&refresh_token=" +
    formEncode(refresh) +
    "&grant_type=refresh_token";
  const res = http(
    "POST",
    "https://oauth2.googleapis.com/token",
    ["Content-Type: application/x-www-form-urlencoded"],
    body,
  );
  if (res.status < 200 || res.status >= 300) return secret;
  const json = parseJson(res.body);
  if (json == null || json.access_token == null) return secret;
  return json.access_token;
}

function fetchGemini(request: FetchOneRequest): FetchOneResult {
  const token = geminiToken(request);
  if (token.length === 0) {
    return fail(request.id, request.nowMs, "not_found", "Sign in with Gemini CLI, then Refresh");
  }
  const headers = ["Authorization: Bearer " + token, "Content-Type: application/json", "Accept: application/json"];
  const assist = http(
    "POST",
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    headers,
    "{\"metadata\":{\"ideType\":\"INTEL_IDE\"}}",
  );
  const assistJson = parseJson(assist.body);
  if (assistJson != null && assistJson.ineligibleTiers != null) {
    let migrated = false;
    let i = 0;
    while (i < assistJson.ineligibleTiers.length) {
      if (assistJson.ineligibleTiers[i].reasonCode === "UNSUPPORTED_CLIENT") migrated = true;
      i = i + 1;
    }
    if (migrated && assistJson.currentTier == null) {
      return fail(request.id, request.nowMs, "migrated", "Use Antigravity for this Google account");
    }
  }
  const quota = http(
    "POST",
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    headers,
    "{}",
  );
  if (quota.status < 200 || quota.status >= 300) {
    if (assist.status === 403 || quota.status === 403) {
      return fail(request.id, request.nowMs, "migrated", "Use Antigravity for this Google account");
    }
    return fail(request.id, request.nowMs, httpKind(quota.status), httpErrorText(quota.status));
  }
  const json = parseJson(quota.body);
  if (json == null) return fail(request.id, request.nowMs, "unknown", "Network error");
  const windows: QuotaWindow[] = [];
  if (json.buckets != null) {
    let i = 0;
    while (i < json.buckets.length && windows.length < 4) {
      const bucket = json.buckets[i];
      const remaining = bucket.remainingFraction ?? bucket.remaining_fraction;
      if (remaining != null) {
        const used = clampPercent((1 - remaining) * 100);
        const title = bucket.displayName ?? "Quota";
        windows.push(bar(i + 1, title, used, 0));
      }
      i = i + 1;
    }
  }
  if (windows.length === 0 && json.remaining != null && json.total != null && json.total > 0) {
    windows.push(bar(1, "Daily", clampPercent(100 - (json.remaining / json.total) * 100), 0));
  }
  if (windows.length === 0) return fail(request.id, request.nowMs, "unknown", "Not found");
  return okResult(request.id, request.nowMs, "gemini-cli", "Gemini", windows);
}

function fetchAntigravity(request: FetchOneRequest): FetchOneResult {
  try {
    const out = execFileSync("agy", ["-p", "/usage", "--output-format", "json"], {
      encoding: "utf8",
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    });
    const json = parseJson(out);
    if (json != null) {
      const windows: QuotaWindow[] = [];
      const weekly = percentFromWindow(json.weekly ?? json.weeklyUsage);
      if (weekly >= 0) windows.push(bar(1, "Weekly", weekly, resetMsFromWindow(json.weekly ?? json.weeklyUsage, request.nowMs)));
      const session = percentFromWindow(json.five_hour ?? json.rolling);
      if (session >= 0) windows.push(bar(2, "Session", session, resetMsFromWindow(json.five_hour ?? json.rolling, request.nowMs)));
      if (windows.length > 0) {
        return okResult(request.id, request.nowMs, "agy", "Google", windows);
      }
    }
  } catch {
    // agy が無いときは Gemini OAuth と同じ枠を読む
  }
  const gemini = fetchGemini({
    id: "gemini",
    source: request.source,
    region: request.region,
    secret: request.secret,
    nowMs: request.nowMs,
  });
  if (gemini.ok) {
    return {
      ok: true,
      id: "antigravity",
      account: gemini.account,
      plan: encodeText("Google"),
      windows: gemini.windows,
      errorKind: "none",
      errorText: EMPTY,
      fetchedAtMs: request.nowMs,
    };
  }
  if (gemini.errorKind === "migrated") {
    return fail(request.id, request.nowMs, "not_found", "Install agy, or sign in with Gemini CLI, then Refresh");
  }
  if (gemini.errorKind === "not_found") {
    return fail(request.id, request.nowMs, "not_found", "Install agy, or sign in with Gemini CLI, then Refresh");
  }
  return fail(request.id, request.nowMs, gemini.errorKind, decodeBytes(gemini.errorText));
}

function fetchOpenCode(request: FetchOneRequest): FetchOneResult {
  const secret = secretText(request);
  if (secret.length === 0) {
    return fail(request.id, request.nowMs, "not_found", "Paste an OpenCode API key or site cookie in Settings");
  }
  if (request.source !== "cookie" && !looksLikeCookie(secret)) {
    const res = http(
      "GET",
      "https://opencode.ai/zen/go/v1/usage",
      ["Authorization: Bearer " + secret, "Accept: application/json"],
      "",
    );
    if (res.status >= 200 && res.status < 300) {
      const json = parseJson(res.body);
      const usage = json != null ? json.usage ?? json.data ?? json : null;
      const windows: QuotaWindow[] = [];
      if (usage != null) {
        const rolling = percentFromWindow(usage.rolling ?? usage.rollingUsage ?? usage.five_hour);
        if (rolling >= 0) {
          windows.push(bar(1, "Session", rolling, resetMsFromWindow(usage.rolling ?? usage.rollingUsage ?? usage.five_hour, request.nowMs)));
        }
        const weekly = percentFromWindow(usage.weekly ?? usage.weeklyUsage ?? usage.seven_day);
        if (weekly >= 0) {
          windows.push(bar(2, "Weekly", weekly, resetMsFromWindow(usage.weekly ?? usage.weeklyUsage ?? usage.seven_day, request.nowMs)));
        }
      }
      if (windows.length > 0) return okResult(request.id, request.nowMs, "opencode", "Zen", windows);
    }
    if (res.status === 401 || res.status === 403) {
      return fail(request.id, request.nowMs, "auth", "Auth expired");
    }
  }
  const cookie = cookieHeader(secret);
  const res = http(
    "GET",
    "https://opencode.ai/_server",
    ["Cookie: " + cookie, "Accept: application/json", "Referer: https://opencode.ai/"],
    "",
  );
  if (res.status < 200 || res.status >= 300) {
    return fail(request.id, request.nowMs, httpKind(res.status), httpErrorText(res.status));
  }
  const json = parseJson(res.body);
  const usage = json != null ? json.usage ?? json.data ?? json : null;
  const windows: QuotaWindow[] = [];
  if (usage != null) {
    const rolling = percentFromWindow(usage.rolling ?? usage.rollingUsage);
    if (rolling >= 0) windows.push(bar(1, "Session", rolling, resetMsFromWindow(usage.rolling ?? usage.rollingUsage, request.nowMs)));
    const weekly = percentFromWindow(usage.weekly ?? usage.weeklyUsage);
    if (weekly >= 0) windows.push(bar(2, "Weekly", weekly, resetMsFromWindow(usage.weekly ?? usage.weeklyUsage, request.nowMs)));
  }
  if (windows.length === 0) {
    return fail(request.id, request.nowMs, "unknown", "Not found");
  }
  return okResult(request.id, request.nowMs, "opencode", "OpenCode", windows);
}

function alibabaUrl(region: AlibabaRegion): string {
  if (region === "cn") {
    return "https://bailian.console.aliyun.com/data/api.json?action=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2&product=broadscope-bailian&api=queryCodingPlanInstanceInfoV2&currentRegionId=cn-beijing";
  }
  return "https://modelstudio.console.alibabacloud.com/data/api.json?action=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2&product=broadscope-bailian&api=queryCodingPlanInstanceInfoV2&currentRegionId=ap-southeast-1";
}

function alibabaWindows(json: LooseJson, nowMs: number): QuotaWindow[] {
  const nested = json.data ?? json.usage ?? json;
  const windows: QuotaWindow[] = [];
  const session = percentFromWindow(nested.five_hour ?? nested.fiveHour ?? nested.rolling);
  if (session >= 0) windows.push(bar(1, "Session", session, resetMsFromWindow(nested.five_hour ?? nested.fiveHour ?? nested.rolling, nowMs)));
  const weekly = percentFromWindow(nested.weekly ?? nested.week ?? nested.seven_day);
  if (weekly >= 0) windows.push(bar(2, "Weekly", weekly, resetMsFromWindow(nested.weekly ?? nested.week ?? nested.seven_day, nowMs)));
  const monthly = percentFromWindow(nested.monthly ?? nested.month);
  if (monthly >= 0) windows.push(bar(3, "Monthly", monthly, resetMsFromWindow(nested.monthly ?? nested.month, nowMs)));
  return windows;
}

function fetchAlibaba(request: FetchOneRequest): FetchOneResult {
  const secret = secretText(request);
  if (secret.length === 0) {
    return fail(request.id, request.nowMs, "not_found", "Paste a Model Studio API key or console cookie in Settings");
  }
  const url = alibabaUrl(request.region);
  const body = "{\"queryCodingPlanInstanceInfoRequest\":{}}";
  let res: HttpResult;
  if (request.source === "cookie" || looksLikeCookie(secret)) {
    res = http(
      "POST",
      url,
      [
        "Cookie: " + cookieHeader(secret),
        "Content-Type: application/json",
        "Accept: application/json",
        "Origin: https://modelstudio.console.alibabacloud.com",
      ],
      body,
    );
  } else {
    res = http(
      "POST",
      url,
      ["Authorization: Bearer " + secret, "Content-Type: application/json", "Accept: application/json"],
      body,
    );
  }
  if (res.status < 200 || res.status >= 300) {
    return fail(request.id, request.nowMs, httpKind(res.status), httpErrorText(res.status));
  }
  const json = parseJson(res.body);
  if (json == null) return fail(request.id, request.nowMs, "unknown", "Network error");
  const windows = alibabaWindows(json, request.nowMs);
  if (windows.length === 0) return fail(request.id, request.nowMs, "unknown", "Not found");
  const plan = request.region === "cn" ? "CN" : "intl";
  return okResult(request.id, request.nowMs, plan, "Coding Plan", windows);
}

function kieRemaining(json: LooseJson | null): number {
  if (json == null) return -1;
  if (json.remaining != null && json.remaining === json.remaining) {
    if (json.remaining >= 0 && json.remaining <= 9007199254740991) return Math.trunc(json.remaining);
    return 0;
  }
  return -1;
}

function resetMsFromIsoOrUnix(raw: string | number | undefined, nowMs: number): number {
  if (raw == null) return 0;
  if (typeof raw === "number") return resetMsFromUnix(raw, nowMs);
  if (raw.length === 0) return 0;
  return parseTimeMs(raw);
}

function stripBearer(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length >= 7) {
    const prefix = trimmed.slice(0, 7).toLowerCase();
    if (prefix === "bearer ") return trimmed.slice(7).trim();
  }
  return trimmed;
}

function headerLineValue(secret: string, header: string): string {
  const needle = header.toLowerCase() + ":";
  const lower = secret.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 0) return "";
  const from = idx + needle.length;
  const rest = secret.slice(from);
  const nl = rest.indexOf("\n");
  const line = nl >= 0 ? rest.slice(0, nl) : rest;
  return line.trim();
}

function parseDevinSecret(secret: string): { org: string; token: string } {
  const fromOrgHeader = headerLineValue(secret, "x-cog-org-id");
  const fromAuth = stripBearer(headerLineValue(secret, "authorization"));
  if (fromOrgHeader.length > 0 && fromAuth.length > 0) {
    return { org: fromOrgHeader, token: fromAuth };
  }
  const nl = secret.indexOf("\n");
  if (nl >= 0) {
    const first = secret.slice(0, nl).trim();
    const rest = stripBearer(secret.slice(nl + 1).trim());
    if (first.length > 0 && rest.length > 0) return { org: first, token: rest };
  }
  const trimmed = secret.trim();
  if (trimmed.indexOf("org_") === 0) {
    const colon = trimmed.indexOf(":");
    const space = trimmed.indexOf(" ");
    let split = -1;
    if (colon > 0 && (space < 0 || colon < space)) split = colon;
    else if (space > 0) split = space;
    if (split > 0) {
      return { org: trimmed.slice(0, split).trim(), token: stripBearer(trimmed.slice(split + 1).trim()) };
    }
  }
  return { org: "", token: "" };
}

function fetchDevin(request: FetchOneRequest): FetchOneResult {
  const parsed = parseDevinSecret(secretText(request));
  if (parsed.org.length === 0 || parsed.token.length === 0) {
    return fail(request.id, request.nowMs, "not_found", "Paste org id and Bearer token in Settings");
  }
  const url = "https://app.devin.ai/api/" + parsed.org + "/billing/quota/usage";
  const res = http(
    "GET",
    url,
    [
      "Authorization: Bearer " + parsed.token,
      "x-cog-org-id: " + parsed.org,
      "Accept: application/json",
    ],
    "",
  );
  if (res.status === 401 || res.status === 403) {
    return fail(request.id, request.nowMs, "auth", "Auth expired");
  }
  if (res.status < 200 || res.status >= 300) {
    return fail(request.id, request.nowMs, httpKind(res.status), httpErrorText(res.status));
  }
  let hasAlloc = true;
  let hideDaily = false;
  let overage = 0;
  let dailyPct = -1;
  let weeklyPct = -1;
  let dailyReset = 0;
  let weeklyReset = 0;
  try {
    const parsedJson = JSON.parse(res.body) as {
      has_quota_allocation?: boolean;
      hide_daily_quota?: boolean;
      overage_balance?: number;
      daily_quota?: { used_percent?: number; reset_at?: string };
      weekly_quota?: { used_percent?: number; reset_at?: string };
    };
    if (parsedJson.has_quota_allocation === false) hasAlloc = false;
    if (parsedJson.hide_daily_quota === true) hideDaily = true;
    if (parsedJson.overage_balance != null && parsedJson.overage_balance === parsedJson.overage_balance) {
      overage = parsedJson.overage_balance < 0 ? 0 : parsedJson.overage_balance;
    }
    if (parsedJson.daily_quota != null && parsedJson.daily_quota.used_percent != null) {
      dailyPct = clampPercent(parsedJson.daily_quota.used_percent);
      dailyReset = resetMsFromIsoOrUnix(parsedJson.daily_quota.reset_at, request.nowMs);
    }
    if (parsedJson.weekly_quota != null && parsedJson.weekly_quota.used_percent != null) {
      weeklyPct = clampPercent(parsedJson.weekly_quota.used_percent);
      weeklyReset = resetMsFromIsoOrUnix(parsedJson.weekly_quota.reset_at, request.nowMs);
    }
  } catch {
    const json = parseJson(res.body);
    if (json == null) return fail(request.id, request.nowMs, "unknown", "Network error");
    if (json.has_quota_allocation === false) hasAlloc = false;
    if (json.hide_daily_quota === true) hideDaily = true;
    if (json.overage_balance != null && json.overage_balance === json.overage_balance) {
      overage = json.overage_balance < 0 ? 0 : json.overage_balance;
    }
    dailyPct = percentFromWindow(json.daily_quota);
    weeklyPct = percentFromWindow(json.weekly_quota);
    dailyReset = resetMsFromWindow(json.daily_quota, request.nowMs);
    weeklyReset = resetMsFromWindow(json.weekly_quota, request.nowMs);
  }
  if (!hasAlloc) {
    return fail(request.id, request.nowMs, "not_found", "No Devin quota for this org");
  }
  const windows: QuotaWindow[] = [];
  if (!hideDaily && dailyPct >= 0) windows.push(bar(1, "Daily", dailyPct, dailyReset));
  if (weeklyPct >= 0) windows.push(bar(2, "Weekly", weeklyPct, weeklyReset));
  if (overage > 0) {
    const safeOverage = overage >= 0 && overage <= 9007199254740991 ? Math.trunc(overage) : 0;
    windows.push(countBar(3, "Overage", safeOverage));
  }
  if (windows.length === 0) return fail(request.id, request.nowMs, "unknown", "Not found");
  return okResult(request.id, request.nowMs, parsed.org, "Daily/Weekly", windows);
}

function fetchKie(request: FetchOneRequest): FetchOneResult {
  const secret = secretText(request);
  if (secret.length === 0) {
    return fail(request.id, request.nowMs, "not_found", "Paste a kie.ai API key in Settings");
  }
  const res = http(
    "GET",
    "https://api.kie.ai/api/v1/chat/credit",
    ["Authorization: Bearer " + secret, "Accept: application/json"],
    "",
  );
  if (res.status === 401 || res.status === 403) {
    return fail(request.id, request.nowMs, "auth", "Auth expired");
  }
  if (res.status < 200 || res.status >= 300) {
    return fail(request.id, request.nowMs, httpKind(res.status), httpErrorText(res.status));
  }
  let code = 0;
  let remaining = -1;
  try {
    const parsed = JSON.parse(res.body) as { code?: number; msg?: string; data?: number };
    if (parsed.code != null && parsed.code === parsed.code) code = parsed.code;
    if (typeof parsed.data === "number" && parsed.data === parsed.data) {
      remaining = parsed.data < 0 ? 0 : parsed.data;
    }
  } catch {
    return fail(request.id, request.nowMs, "unknown", "Network error");
  }
  if (code === 401 || code === 403) {
    return fail(request.id, request.nowMs, "auth", "Auth expired");
  }
  if (remaining < 0) {
    remaining = kieRemaining(parseJson(res.body));
  }
  if (code !== 200 && code !== 0) {
    return fail(request.id, request.nowMs, "unknown", "Not found");
  }
  if (remaining < 0) {
    return fail(request.id, request.nowMs, "unknown", "Not found");
  }
  const safeRemaining = remaining >= 0 && remaining <= 9007199254740991 ? Math.trunc(remaining) : 0;
  return okResult(request.id, request.nowMs, "kie.ai", "Credits", [countBar(1, "Credits", safeRemaining)]);
}

/**
 * @deadlineMs 20000
 */
export function fetchOne(request: FetchOneRequest): FetchOneResult {
  try {
    if (request.id === "claude") return fetchClaude(request);
    if (request.id === "codex") return fetchCodex(request);
    if (request.id === "cursor") return fetchCursor(request);
    if (request.id === "gemini") return fetchGemini(request);
    if (request.id === "antigravity") return fetchAntigravity(request);
    if (request.id === "opencode") return fetchOpenCode(request);
    if (request.id === "alibaba") return fetchAlibaba(request);
    if (request.id === "kie") return fetchKie(request);
    if (request.id === "devin") return fetchDevin(request);
    return fail(request.id, request.nowMs, "unknown", "Not found");
  } catch (e) {
    if (e instanceof Error) {
      return fail(request.id, request.nowMs, "unknown", "Network error");
    }
    return fail(request.id, request.nowMs, "unknown", "Network error");
  }
}

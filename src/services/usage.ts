// 8 プロバイダの利用量を同期取得する。throw せず FetchOneResult を返す。

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import type {
  AlibabaRegion,
  AuthSource,
  ErrorKind,
  FetchOneRequest,
  FetchOneResult,
  ProviderId,
  QuotaWindow,
} from "../snapshot.ts";
import { resolve } from "./paths.ts";

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
  cursorModels?: LooseWindow;
  namedModelUsage?: LooseWindow;
  thirdParty?: LooseWindow;
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

function pathFor(kind: "claude" | "codex" | "cursor" | "gemini"): string {
  return decodeBytes(resolve({ kind: kind }).path);
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

function readClaudeToken(source: AuthSource, secret: string): string {
  if (source === "cookie" || source === "api") return secret;
  const file = parseJson(readTextFile(pathFor("claude")));
  if (file != null && file.claudeAiOauth != null) {
    const token = file.claudeAiOauth.accessToken ?? file.claudeAiOauth.access_token;
    if (token != null && token.length > 0) return token;
  }
  if (file != null && file.access_token != null && file.access_token.length > 0) {
    return file.access_token;
  }
  return secret;
}

function fetchClaude(request: FetchOneRequest): FetchOneResult {
  const secret = secretText(request);
  const token = readClaudeToken(request.source, secret);
  if (token.length === 0) {
    return fail(request.id, request.nowMs, "not_found", "Install Claude Code and sign in, then Refresh");
  }
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
  return okResult(request.id, request.nowMs, "claude-code", "Claude", windows);
}

function readCodexToken(source: AuthSource, secret: string): string {
  if (source === "api" || source === "cookie") return secret;
  const file = parseJson(readTextFile(pathFor("codex")));
  if (file != null && file.tokens != null) {
    const token = file.tokens.access_token ?? file.tokens.accessToken;
    if (token != null && token.length > 0) return token;
  }
  if (file != null && file.access_token != null && file.access_token.length > 0) {
    return file.access_token;
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

function readCursorTokenFromDb(): string {
  const dbPath = pathFor("cursor");
  if (!existsSync(dbPath)) return "";
  try {
    const out = execFileSync(
      "sqlite3",
      ["-readonly", dbPath, "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1;"],
      { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 },
    );
    return out.trim();
  } catch {
    return "";
  }
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
  const planPct = percentFromWindow(planWin);
  if (planPct >= 0) windows.push(bar(1, "Plan", planPct, cycleMs));
  const cursorPct = percentFromWindow(json.cursorModels ?? json.namedModelUsage);
  if (cursorPct >= 0) windows.push(bar(2, "Cursor", cursorPct, cycleMs));
  const thirdPct = percentFromWindow(json.thirdParty);
  if (thirdPct >= 0) windows.push(bar(3, "Third party", thirdPct, cycleMs));
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
        windows.push(bar(4, "Grok Bot", sandJson.usagePercent, reset));
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
  const file = parseJson(readTextFile(pathFor("gemini")));
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
    return fail(request.id, request.nowMs, "unknown", "Not found");
  } catch (e) {
    if (e instanceof Error) {
      return fail(request.id, request.nowMs, "unknown", "Network error");
    }
    return fail(request.id, request.nowMs, "unknown", "Network error");
  }
}

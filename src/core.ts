// QuotaBar の決定的コア。時刻は Msg、秘密は Cmd.credentials、HTTP は services。

import {
  Cmd,
  Sub,
  asciiBytes,
  utf8Bytes,
  windowDescriptor,
} from "@native-sdk/core";
import {
  applyTextInputEvent,
  clampedInsertEvent,
  type TextInputEvent,
} from "@native-sdk/core/text";
import {
  type StatusItemState,
  type ThemeState,
  type WindowDescriptor,
} from "@native-sdk/core/events";
import { usageFetchOne } from "@native-sdk/services";
import { demoProviders, emptyProvider } from "./demo.ts";
import {
  formatAgo,
  formatReset,
  intervalLabel,
  leftLabel,
  permilleFraction,
} from "./format.ts";
import type {
  AuthSource,
  CardBar,
  CardView,
  ErrorKind,
  FetchOneRequest,
  FetchOneResult,
  ProviderId,
  ProviderState,
  ProviderStatus,
  QuotaTone,
  QuotaWindow,
  QuotaWindows,
  AlibabaRegion,
  SettingsRow,
} from "./snapshot.ts";

const MAX_SECRET = 2500;
const EMPTY = asciiBytes("");

export interface Model {
  readonly nowMs: number;
  readonly lastRefreshMs: number;
  readonly refreshIntervalSec: number;
  readonly demoMode: boolean;
  readonly forceError: boolean;
  readonly compactOpen: boolean;
  readonly dashboardOpen: boolean;
  readonly settingsOpen: boolean;
  readonly alibabaRegion: AlibabaRegion;
  readonly credSlot: number;
  readonly credBytes: Uint8Array;
  readonly credAnchor: number;
  readonly credFocus: number;
  readonly secretNotice: Uint8Array;
  readonly providers: readonly ProviderState[];
}

export type Msg =
  | { readonly kind: "tick"; readonly nowMs: number }
  | { readonly kind: "refresh_tick"; readonly nowMs: number }
  | { readonly kind: "refresh_requested" }
  | { readonly kind: "fetched"; readonly result: FetchOneResult }
  | { readonly kind: "fetch_failed"; readonly error: Uint8Array }
  | { readonly kind: "secret_claude"; readonly secret: Uint8Array }
  | { readonly kind: "miss_claude"; readonly reason: Uint8Array }
  | { readonly kind: "secret_codex"; readonly secret: Uint8Array }
  | { readonly kind: "miss_codex"; readonly reason: Uint8Array }
  | { readonly kind: "secret_cursor"; readonly secret: Uint8Array }
  | { readonly kind: "miss_cursor"; readonly reason: Uint8Array }
  | { readonly kind: "secret_antigravity"; readonly secret: Uint8Array }
  | { readonly kind: "miss_antigravity"; readonly reason: Uint8Array }
  | { readonly kind: "secret_gemini"; readonly secret: Uint8Array }
  | { readonly kind: "miss_gemini"; readonly reason: Uint8Array }
  | { readonly kind: "secret_opencode"; readonly secret: Uint8Array }
  | { readonly kind: "miss_opencode"; readonly reason: Uint8Array }
  | { readonly kind: "secret_alibaba"; readonly secret: Uint8Array }
  | { readonly kind: "miss_alibaba"; readonly reason: Uint8Array }
  | { readonly kind: "toggle_provider"; readonly slot: number }
  | { readonly kind: "cycle_source"; readonly slot: number }
  | { readonly kind: "cycle_region" }
  | { readonly kind: "toggle_demo" }
  | { readonly kind: "toggle_force_error" }
  | { readonly kind: "set_interval_30" }
  | { readonly kind: "set_interval_60" }
  | { readonly kind: "set_interval_120" }
  | { readonly kind: "toggle_compact" }
  | { readonly kind: "hide_compact" }
  | { readonly kind: "open_dashboard" }
  | { readonly kind: "hide_dashboard" }
  | { readonly kind: "open_settings" }
  | { readonly kind: "hide_settings" }
  | { readonly kind: "quit" }
  | { readonly kind: "focus_secret"; readonly slot: number }
  | { readonly kind: "clear_secret"; readonly slot: number }
  | { readonly kind: "cred_edit"; readonly edit: TextInputEvent }
  | { readonly kind: "save_secret" }
  | { readonly kind: "clear_draft" }
  | { readonly kind: "secret_saved" }
  | { readonly kind: "secret_failed"; readonly reason: Uint8Array }
  | { readonly kind: "secret_cleared" }
  | { readonly kind: "clear_failed"; readonly reason: Uint8Array }
  | { readonly kind: "restored" }
  | { readonly kind: "fresh_boot" }
  | { readonly kind: "restore_failed"; readonly reason: Uint8Array };

export const viewUnbound = [
  "tick",
  "refresh_tick",
  "fetched",
  "fetch_failed",
  "secret_claude",
  "miss_claude",
  "secret_codex",
  "miss_codex",
  "secret_cursor",
  "miss_cursor",
  "secret_antigravity",
  "miss_antigravity",
  "secret_gemini",
  "miss_gemini",
  "secret_opencode",
  "miss_opencode",
  "secret_alibaba",
  "miss_alibaba",
  "secret_saved",
  "secret_failed",
  "secret_cleared",
  "clear_failed",
  "restored",
  "fresh_boot",
  "restore_failed",
  "nowMs",
  "lastRefreshMs",
  "refreshIntervalSec",
  "compactOpen",
  "dashboardOpen",
  "settingsOpen",
  "alibabaRegion",
  "credSlot",
  "credAnchor",
  "credFocus",
  "providers",
  "cred_edit",
] as const;

export function initialModel(): [Model, Cmd<Msg>] {
  const providers: ProviderState[] = [
    emptyProvider("claude", true),
    emptyProvider("codex", true),
    emptyProvider("cursor", true),
    emptyProvider("antigravity", true),
    emptyProvider("gemini", true),
    emptyProvider("opencode", true),
    emptyProvider("alibaba", true),
  ];
  return [
    {
      nowMs: 0,
      lastRefreshMs: 0,
      refreshIntervalSec: 60,
      demoMode: true,
      forceError: false,
      compactOpen: true,
      dashboardOpen: false,
      settingsOpen: false,
      alibabaRegion: "intl",
      credSlot: 0,
      credBytes: new Uint8Array(0),
      credAnchor: 0,
      credFocus: 0,
      secretNotice: EMPTY,
      providers: providers,
    },
    Cmd.now("tick"),
  ];
}

function providerName(id: ProviderId): Uint8Array {
  switch (id) {
    case "claude":
      return asciiBytes("Claude");
    case "codex":
      return asciiBytes("Codex");
    case "cursor":
      return asciiBytes("Cursor");
    case "antigravity":
      return asciiBytes("Antigravity");
    case "gemini":
      return asciiBytes("Gemini");
    case "opencode":
      return asciiBytes("OpenCode");
    case "alibaba":
      return asciiBytes("Alibaba");
  }
}

function sourceBadge(source: AuthSource): Uint8Array {
  switch (source) {
    case "auto":
      return asciiBytes("auto");
    case "oauth":
      return asciiBytes("oauth");
    case "cli":
      return asciiBytes("cli");
    case "cookie":
      return asciiBytes("cookie");
    case "api":
      return asciiBytes("api");
  }
}

function missingHint(id: ProviderId): Uint8Array {
  switch (id) {
    case "claude":
      return asciiBytes("Install Claude Code and sign in, then Refresh");
    case "codex":
      return asciiBytes("Sign in with Codex CLI (auth.json), then Refresh");
    case "cursor":
      return asciiBytes("Sign in to the Cursor app, or paste a cursor.com cookie");
    case "antigravity":
      return asciiBytes("Install agy, or sign in with Gemini CLI, then Refresh");
    case "gemini":
      return asciiBytes("Sign in with Gemini CLI, then Refresh");
    case "opencode":
      return asciiBytes("Paste an OpenCode API key or site cookie in Settings");
    case "alibaba":
      return asciiBytes("Paste a Model Studio API key or console cookie in Settings");
  }
}

function settingsHint(id: ProviderId): Uint8Array {
  switch (id) {
    case "claude":
      return asciiBytes("Reads ~/.claude/.credentials.json. Optional session key in the secret field.");
    case "codex":
      return asciiBytes("Reads ~/.codex/auth.json or $CODEX_HOME/auth.json.");
    case "cursor":
      return asciiBytes("Reads Cursor state.vscdb, or a WorkosCursorSessionToken cookie.");
    case "antigravity":
      return asciiBytes("Runs agy -p /usage, then Gemini OAuth quota.");
    case "gemini":
      return asciiBytes("Reads ~/.gemini/oauth_creds.json. Consumer OAuth may have moved to Antigravity.");
    case "opencode":
      return asciiBytes("API key hits zen usage. Cookie hits the OpenCode subscription page.");
    case "alibaba":
      return asciiBytes("API key first, cookie second. Cycle region for intl vs cn.");
  }
}

function nextSource(source: AuthSource): AuthSource {
  switch (source) {
    case "auto":
      return "oauth";
    case "oauth":
      return "cli";
    case "cli":
      return "cookie";
    case "cookie":
      return "api";
    case "api":
      return "auto";
  }
}

function emptyWindows(): readonly QuotaWindow[] {
  const items: QuotaWindow[] = [];
  return items;
}

function barTone(usedPercent: number): QuotaTone {
  if (usedPercent > 90) return "destructive";
  if (usedPercent > 50) return "warning";
  return "normal";
}

function toModelWindows(bundle: QuotaWindows): readonly QuotaWindow[] {
  const out: QuotaWindow[] = [];
  for (const w of bundle.items) {
    const id = w.id >= 0 && w.id <= 9007199254740991 ? Math.trunc(w.id) : 0;
    const usedRaw = w.usedPercent;
    const usedPercent = usedRaw >= 0 && usedRaw <= 100 ? Math.trunc(usedRaw) : usedRaw > 100 ? 100 : 0;
    const resetsAtMs = w.resetsAtMs >= 0 && w.resetsAtMs <= 9007199254740991 ? Math.trunc(w.resetsAtMs) : 0;
    out.push({
      id: id,
      title: w.title,
      usedPercent: usedPercent,
      resetsAtMs: resetsAtMs,
    });
  }
  return out;
}

function toBars(nowMs: number, windows: readonly QuotaWindow[]): readonly CardBar[] {
  const out: CardBar[] = [];
  for (const w of windows) {
    const usedRaw = w.usedPercent;
    const used = usedRaw >= 0 && usedRaw <= 100 ? Math.trunc(usedRaw) : usedRaw > 100 ? 100 : 0;
    out.push({
      id: w.id,
      title: w.title,
      usedPercent: used,
      usedFraction: permilleFraction(used * 10),
      leftLabel: leftLabel(used),
      resetLabel: formatReset(nowMs, w.resetsAtMs),
      tone: barTone(used),
    });
  }
  return out;
}

function cardFromProvider(nowMs: number, p: ProviderState, forceError: boolean): CardView {
  const status: ProviderStatus = forceError && p.status === "ready" ? "failed" : p.status;
  const errorText =
    forceError && p.status === "ready" ? asciiBytes("Auth expired") : p.errorText;
  return {
    id: p.slot,
    slot: p.slot,
    name: providerName(p.id),
    plan: p.plan.length === 0 ? asciiBytes("-") : p.plan,
    sourceBadge: sourceBadge(p.source),
    status: status,
    account: p.account,
    errorText: errorText,
    hint: missingHint(p.id),
    stale: p.stale,
    bars: toBars(nowMs, p.windows),
  };
}

export function visibleCards(model: Model): readonly CardView[] {
  const out: CardView[] = [];
  for (const p of model.providers) {
    if (!p.enabled) continue;
    const force = model.forceError && out.length === 0;
    out.push(cardFromProvider(model.nowMs, p, force));
  }
  return out;
}

export function hasVisibleCards(model: Model): boolean {
  return visibleCards(model).length > 0;
}

export function updatedLabel(model: Model): Uint8Array {
  return formatAgo(model.nowMs, model.lastRefreshMs);
}

export function intervalCaption(model: Model): Uint8Array {
  return intervalLabel(model.refreshIntervalSec);
}

export function settingsRows(model: Model): readonly SettingsRow[] {
  const out: SettingsRow[] = [];
  for (const p of model.providers) {
    out.push({
      id: p.slot,
      slot: p.slot,
      name: providerName(p.id),
      enabled: p.enabled,
      sourceLabel: sourceBadge(p.source),
      regionLabel: model.alibabaRegion === "intl" ? asciiBytes("Region intl") : asciiBytes("Region cn"),
      showRegion: p.id === "alibaba",
      credentialPresent: p.credentialPresent,
      hint: settingsHint(p.id),
    });
  }
  return out;
}

export function secretTargetName(model: Model): Uint8Array {
  const p = model.providers.find((row) => row.slot === model.credSlot);
  if (p === undefined) return asciiBytes("Claude");
  return providerName(p.id);
}

export function credText(model: Model): Uint8Array {
  return model.credBytes;
}

export function hasSecretNotice(model: Model): boolean {
  return model.secretNotice.length > 0;
}

function mapProviders(
  model: Model,
  fn: (p: ProviderState) => ProviderState,
): readonly ProviderState[] {
  const out: ProviderState[] = [];
  for (const p of model.providers) out.push(fn(p));
  return out;
}

function patchProvider(
  model: Model,
  id: ProviderId,
  fn: (p: ProviderState) => ProviderState,
): Model {
  return {
    ...model,
    providers: mapProviders(model, (p) => (p.id === id ? fn(p) : p)),
  };
}

function patchSlot(
  model: Model,
  slot: number,
  fn: (p: ProviderState) => ProviderState,
): Model {
  return {
    ...model,
    providers: mapProviders(model, (p) => (p.slot === slot ? fn(p) : p)),
  };
}

function applyDemo(model: Model): Model {
  const seeded = demoProviders(model.nowMs);
  const merged: ProviderState[] = [];
  for (const p of model.providers) {
    const demo = seeded.find((d) => d.id === p.id);
    if (demo === undefined) {
      merged.push(p);
    } else {
      merged.push({
        ...demo,
        enabled: p.enabled,
        source: p.source,
        credentialPresent: p.credentialPresent,
        fetchedAtMs: model.nowMs,
      });
    }
  }
  return { ...model, lastRefreshMs: model.nowMs, providers: merged };
}

function markLoading(model: Model): Model {
  return {
    ...model,
    lastRefreshMs: model.nowMs,
    providers: mapProviders(model, (p) => {
      if (!p.enabled) return p;
      const stale = p.status === "ready" && p.windows.length > 0;
      return { ...p, status: "loading", stale: stale, errorKind: "none", errorText: EMPTY };
    }),
  };
}

function markLoadingFailed(model: Model, text: Uint8Array): Model {
  return {
    ...model,
    providers: mapProviders(model, (p) => {
      if (p.status !== "loading") return p;
      const stale = p.windows.length > 0;
      return {
        ...p,
        status: "failed",
        stale: stale,
        errorKind: "network",
        errorText: text.length === 0 ? asciiBytes("Network error") : text,
      };
    }),
  };
}

function applyFetch(model: Model, result: FetchOneResult): Model {
  const fetchedAtMs = result.fetchedAtMs >= 0 && result.fetchedAtMs <= 9007199254740991
    ? Math.trunc(result.fetchedAtMs)
    : 0;
  return patchProvider(model, result.id, (p) => {
    if (result.ok) {
      return {
        ...p,
        status: "ready",
        account: result.account,
        plan: result.plan,
        windows: toModelWindows(result.windows),
        errorKind: "none",
        errorText: EMPTY,
        fetchedAtMs: fetchedAtMs,
        stale: false,
      };
    }
    const stale = p.windows.length > 0;
    const status: ProviderStatus = result.errorKind === "not_found" || result.errorKind === "migrated"
      ? "missing"
      : "failed";
    return {
      ...p,
      status: status,
      errorKind: result.errorKind,
      errorText: result.errorText,
      fetchedAtMs: fetchedAtMs,
      stale: stale,
      plan: result.plan.length === 0 ? p.plan : result.plan,
      account: result.account.length === 0 ? p.account : result.account,
      windows: result.windows.items.length === 0 ? p.windows : toModelWindows(result.windows),
    };
  });
}

function fetchReq(model: Model, id: ProviderId, secret: Uint8Array): FetchOneRequest {
  const found = model.providers.find((p) => p.id === id);
  const source: AuthSource = found === undefined ? "auto" : found.source;
  return {
    id: id,
    source: source,
    region: model.alibabaRegion,
    secret: secret,
    nowMs: model.nowMs,
  };
}

function withPresent(model: Model, id: ProviderId, present: boolean): Model {
  return patchProvider(model, id, (p) => ({ ...p, credentialPresent: present }));
}

function providerEnabled(model: Model, id: ProviderId): boolean {
  const found = model.providers.find((p) => p.id === id);
  if (found === undefined) return false;
  return found.enabled;
}

function persistable(model: Model): Model {
  return emptyDraft({ ...model, secretNotice: EMPTY });
}

function sanitizeRestored(model: Model): Model {
  return {
    ...model,
    nowMs: 0,
    lastRefreshMs: 0,
    compactOpen: true,
    dashboardOpen: false,
    settingsOpen: false,
    credBytes: new Uint8Array(0),
    credAnchor: 0,
    credFocus: 0,
    secretNotice: EMPTY,
    providers: mapProviders(model, (p) => ({
      ...p,
      status: "idle",
      account: EMPTY,
      plan: EMPTY,
      windows: emptyWindows(),
      errorKind: "none",
      errorText: EMPTY,
      fetchedAtMs: 0,
      stale: false,
    })),
  };
}

function emptyDraft(model: Model): Model {
  return {
    ...model,
    credBytes: new Uint8Array(0),
    credAnchor: 0,
    credFocus: 0,
  };
}

export function update(model: Model, msg: Msg): Model | [Model, Cmd<Msg>] {
  switch (msg.kind) {
    case "tick": {
      const nowMs = msg.nowMs >= 0 && msg.nowMs <= 9007199254740991 ? Math.trunc(msg.nowMs) : 0;
      const next = { ...model, nowMs: nowMs };
      if (model.demoMode && model.lastRefreshMs === 0) return applyDemo(next);
      return next;
    }
    case "refresh_tick": {
      const nowMs = msg.nowMs >= 0 && msg.nowMs <= 9007199254740991 ? Math.trunc(msg.nowMs) : 0;
      const next = { ...model, nowMs: nowMs };
      if (next.demoMode) {
        if (next.lastRefreshMs === 0) return applyDemo(next);
        return { ...next, lastRefreshMs: next.nowMs };
      }
      return [
        markLoading(next),
        Cmd.batch([
          Cmd.credentials.get("claude.session", { key: "cred-claude", ok: "secret_claude", err: "miss_claude" }),
          Cmd.credentials.get("codex.token", { key: "cred-codex", ok: "secret_codex", err: "miss_codex" }),
          Cmd.credentials.get("cursor.cookie", { key: "cred-cursor", ok: "secret_cursor", err: "miss_cursor" }),
          Cmd.credentials.get("antigravity.token", { key: "cred-antigravity", ok: "secret_antigravity", err: "miss_antigravity" }),
          Cmd.credentials.get("gemini.token", { key: "cred-gemini", ok: "secret_gemini", err: "miss_gemini" }),
          Cmd.credentials.get("opencode.api", { key: "cred-opencode", ok: "secret_opencode", err: "miss_opencode" }),
          Cmd.credentials.get("alibaba.api", { key: "cred-alibaba", ok: "secret_alibaba", err: "miss_alibaba" }),
        ]),
      ];
    }
    case "refresh_requested":
      return [model, Cmd.now("refresh_tick")];
    case "fetched":
      return applyFetch(model, msg.result);
    case "fetch_failed":
      return markLoadingFailed(model, msg.error);
    case "secret_claude": {
      const next = withPresent(model, "claude", true);
      if (!providerEnabled(next, "claude")) return next;
      return [next, usageFetchOne(fetchReq(next, "claude", msg.secret), { key: "fetch-claude", ok: "fetched", err: "fetch_failed" })];
    }
    case "miss_claude": {
      if (!providerEnabled(model, "claude")) return model;
      return [model, usageFetchOne(fetchReq(model, "claude", new Uint8Array(0)), { key: "fetch-claude", ok: "fetched", err: "fetch_failed" })];
    }
    case "secret_codex": {
      const next = withPresent(model, "codex", true);
      if (!providerEnabled(next, "codex")) return next;
      return [next, usageFetchOne(fetchReq(next, "codex", msg.secret), { key: "fetch-codex", ok: "fetched", err: "fetch_failed" })];
    }
    case "miss_codex": {
      if (!providerEnabled(model, "codex")) return model;
      return [model, usageFetchOne(fetchReq(model, "codex", new Uint8Array(0)), { key: "fetch-codex", ok: "fetched", err: "fetch_failed" })];
    }
    case "secret_cursor": {
      const next = withPresent(model, "cursor", true);
      if (!providerEnabled(next, "cursor")) return next;
      return [next, usageFetchOne(fetchReq(next, "cursor", msg.secret), { key: "fetch-cursor", ok: "fetched", err: "fetch_failed" })];
    }
    case "miss_cursor": {
      if (!providerEnabled(model, "cursor")) return model;
      return [model, usageFetchOne(fetchReq(model, "cursor", new Uint8Array(0)), { key: "fetch-cursor", ok: "fetched", err: "fetch_failed" })];
    }
    case "secret_antigravity": {
      const next = withPresent(model, "antigravity", true);
      if (!providerEnabled(next, "antigravity")) return next;
      return [next, usageFetchOne(fetchReq(next, "antigravity", msg.secret), { key: "fetch-antigravity", ok: "fetched", err: "fetch_failed" })];
    }
    case "miss_antigravity": {
      if (!providerEnabled(model, "antigravity")) return model;
      return [model, usageFetchOne(fetchReq(model, "antigravity", new Uint8Array(0)), { key: "fetch-antigravity", ok: "fetched", err: "fetch_failed" })];
    }
    case "secret_gemini": {
      const next = withPresent(model, "gemini", true);
      if (!providerEnabled(next, "gemini")) return next;
      return [next, usageFetchOne(fetchReq(next, "gemini", msg.secret), { key: "fetch-gemini", ok: "fetched", err: "fetch_failed" })];
    }
    case "miss_gemini": {
      if (!providerEnabled(model, "gemini")) return model;
      return [model, usageFetchOne(fetchReq(model, "gemini", new Uint8Array(0)), { key: "fetch-gemini", ok: "fetched", err: "fetch_failed" })];
    }
    case "secret_opencode": {
      const next = withPresent(model, "opencode", true);
      if (!providerEnabled(next, "opencode")) return next;
      return [next, usageFetchOne(fetchReq(next, "opencode", msg.secret), { key: "fetch-opencode", ok: "fetched", err: "fetch_failed" })];
    }
    case "miss_opencode": {
      if (!providerEnabled(model, "opencode")) return model;
      return [model, usageFetchOne(fetchReq(model, "opencode", new Uint8Array(0)), { key: "fetch-opencode", ok: "fetched", err: "fetch_failed" })];
    }
    case "secret_alibaba": {
      const next = withPresent(model, "alibaba", true);
      if (!providerEnabled(next, "alibaba")) return next;
      return [next, usageFetchOne(fetchReq(next, "alibaba", msg.secret), { key: "fetch-alibaba", ok: "fetched", err: "fetch_failed" })];
    }
    case "miss_alibaba": {
      if (!providerEnabled(model, "alibaba")) return model;
      return [model, usageFetchOne(fetchReq(model, "alibaba", new Uint8Array(0)), { key: "fetch-alibaba", ok: "fetched", err: "fetch_failed" })];
    }
    case "toggle_provider": {
      const slot = msg.slot >= 0 && msg.slot <= 6 ? Math.trunc(msg.slot) : 0;
      const next = persistable(patchSlot(model, slot, (p) => ({ ...p, enabled: !p.enabled })));
      return [next, Cmd.persist()];
    }
    case "cycle_source": {
      const slot = msg.slot >= 0 && msg.slot <= 6 ? Math.trunc(msg.slot) : 0;
      const next = persistable(patchSlot(model, slot, (p) => ({ ...p, source: nextSource(p.source) })));
      return [next, Cmd.persist()];
    }
    case "cycle_region": {
      const next = persistable({
        ...model,
        alibabaRegion: model.alibabaRegion === "intl" ? "cn" as const : "intl" as const,
      });
      return [next, Cmd.persist()];
    }
    case "toggle_demo": {
      const next = persistable({ ...model, demoMode: !model.demoMode, lastRefreshMs: 0 });
      return [next, Cmd.batch([Cmd.persist(), Cmd.now("refresh_tick")])];
    }
    case "toggle_force_error":
      return { ...model, forceError: !model.forceError };
    case "set_interval_30":
      return [persistable({ ...model, refreshIntervalSec: 30 }), Cmd.persist()];
    case "set_interval_60":
      return [persistable({ ...model, refreshIntervalSec: 60 }), Cmd.persist()];
    case "set_interval_120":
      return [persistable({ ...model, refreshIntervalSec: 120 }), Cmd.persist()];
    case "toggle_compact":
      if (model.compactOpen) return [{ ...model, compactOpen: false }, Cmd.hideWindow("main")];
      return [{ ...model, compactOpen: true }, Cmd.showWindow("main")];
    case "hide_compact":
      return [{ ...model, compactOpen: false }, Cmd.hideWindow("main")];
    case "open_dashboard":
      return { ...model, dashboardOpen: true };
    case "hide_dashboard":
      return { ...model, dashboardOpen: false };
    case "open_settings":
      return { ...model, settingsOpen: true };
    case "hide_settings":
      return { ...model, settingsOpen: false };
    case "quit":
      return [model, Cmd.quitApp()];
    case "focus_secret": {
      const slot = msg.slot >= 0 && msg.slot <= 6 ? Math.trunc(msg.slot) : 0;
      return { ...model, credSlot: slot, secretNotice: EMPTY };
    }
    case "clear_secret": {
      const slot = msg.slot >= 0 && msg.slot <= 6 ? Math.trunc(msg.slot) : 0;
      const next = persistable(
        patchSlot({ ...model, credSlot: slot }, slot, (p) => ({ ...p, credentialPresent: false })),
      );
      if (slot === 0) {
        return [next, Cmd.credentials.delete("claude.session", { key: "cred-del", ok: "secret_cleared", err: "clear_failed" })];
      }
      if (slot === 1) {
        return [next, Cmd.credentials.delete("codex.token", { key: "cred-del", ok: "secret_cleared", err: "clear_failed" })];
      }
      if (slot === 2) {
        return [next, Cmd.credentials.delete("cursor.cookie", { key: "cred-del", ok: "secret_cleared", err: "clear_failed" })];
      }
      if (slot === 3) {
        return [next, Cmd.credentials.delete("antigravity.token", { key: "cred-del", ok: "secret_cleared", err: "clear_failed" })];
      }
      if (slot === 4) {
        return [next, Cmd.credentials.delete("gemini.token", { key: "cred-del", ok: "secret_cleared", err: "clear_failed" })];
      }
      if (slot === 5) {
        return [next, Cmd.credentials.delete("opencode.api", { key: "cred-del", ok: "secret_cleared", err: "clear_failed" })];
      }
      if (slot === 6) {
        return [next, Cmd.credentials.delete("alibaba.api", { key: "cred-del", ok: "secret_cleared", err: "clear_failed" })];
      }
      return next;
    }
    case "cred_edit": {
      const current = {
        text: model.credBytes,
        selection: { anchor: model.credAnchor, focus: model.credFocus },
        composition: null,
      };
      const applied = applyTextInputEvent(current, msg.edit, MAX_SECRET);
      const nextState = applied ?? applyTextInputEvent(current, clampedInsertEvent(current, msg.edit, MAX_SECRET) ?? msg.edit, MAX_SECRET);
      if (nextState === null) return model;
      const credAnchor = nextState.selection.anchor >= 0 && nextState.selection.anchor <= 9007199254740991
        ? Math.trunc(nextState.selection.anchor)
        : 0;
      const credFocus = nextState.selection.focus >= 0 && nextState.selection.focus <= 9007199254740991
        ? Math.trunc(nextState.selection.focus)
        : 0;
      return {
        ...model,
        credBytes: nextState.text,
        credAnchor: credAnchor,
        credFocus: credFocus,
      };
    }
    case "save_secret": {
      if (model.credSlot === 0) {
        return [model, Cmd.credentials.set("claude.session", model.credBytes, { key: "cred-set", ok: "secret_saved", err: "secret_failed" })];
      }
      if (model.credSlot === 1) {
        return [model, Cmd.credentials.set("codex.token", model.credBytes, { key: "cred-set", ok: "secret_saved", err: "secret_failed" })];
      }
      if (model.credSlot === 2) {
        return [model, Cmd.credentials.set("cursor.cookie", model.credBytes, { key: "cred-set", ok: "secret_saved", err: "secret_failed" })];
      }
      if (model.credSlot === 3) {
        return [model, Cmd.credentials.set("antigravity.token", model.credBytes, { key: "cred-set", ok: "secret_saved", err: "secret_failed" })];
      }
      if (model.credSlot === 4) {
        return [model, Cmd.credentials.set("gemini.token", model.credBytes, { key: "cred-set", ok: "secret_saved", err: "secret_failed" })];
      }
      if (model.credSlot === 5) {
        return [model, Cmd.credentials.set("opencode.api", model.credBytes, { key: "cred-set", ok: "secret_saved", err: "secret_failed" })];
      }
      if (model.credSlot === 6) {
        return [model, Cmd.credentials.set("alibaba.api", model.credBytes, { key: "cred-set", ok: "secret_saved", err: "secret_failed" })];
      }
      return model;
    }
    case "clear_draft":
      return emptyDraft(model);
    case "secret_saved": {
      const next = persistable(
        patchSlot(
          { ...model, secretNotice: asciiBytes("Secret saved") },
          model.credSlot,
          (p) => ({ ...p, credentialPresent: true }),
        ),
      );
      return [emptyDraft(next), Cmd.persist()];
    }
    case "secret_failed":
      return { ...model, secretNotice: asciiBytes("Could not save secret") };
    case "secret_cleared":
      return [persistable({ ...model, secretNotice: asciiBytes("Secret cleared") }), Cmd.persist()];
    case "clear_failed":
      return { ...model, secretNotice: asciiBytes("Could not clear secret") };
    case "restored":
      return [sanitizeRestored(model), Cmd.now("tick")];
    case "fresh_boot":
      return [model, Cmd.now("tick")];
    case "restore_failed":
      return [model, Cmd.now("tick")];
  }
}

export function subscriptions(model: Model): Sub<Msg> {
  if (!model.compactOpen && !model.dashboardOpen && !model.settingsOpen) {
    return Sub.timer("refresh", model.refreshIntervalSec * 1000, "refresh_tick");
  }
  return Sub.batch([
    Sub.timer("clock", 15000, "tick"),
    Sub.timer("refresh", model.refreshIntervalSec * 1000, "refresh_tick"),
  ]);
}

export function commandMsg(name: string): Msg | null {
  if (name === "app.open") return { kind: "toggle_compact" };
  if (name === "app.dashboard") return { kind: "open_dashboard" };
  if (name === "app.settings") return { kind: "open_settings" };
  if (name === "app.refresh") return { kind: "refresh_requested" };
  if (name === "app.quit") return { kind: "quit" };
  if (name === "app.dashboard-closed") return { kind: "hide_dashboard" };
  if (name === "app.settings-closed") return { kind: "hide_settings" };
  return null;
}

function noneModifiers(): {
  readonly primary: boolean;
  readonly command: boolean;
  readonly control: boolean;
  readonly option: boolean;
  readonly shift: boolean;
} {
  return { primary: false, command: false, control: false, option: false, shift: false };
}

function menuRow(
  id: number,
  label: string,
  command: string,
  separator: boolean,
): StatusItemState["items"][number] {
  const safeId = id >= 0 && id <= 100 ? Math.trunc(id) : 0;
  return {
    id: safeId,
    label: separator ? EMPTY : asciiBytes(label),
    command: separator ? EMPTY : asciiBytes(command),
    separator: separator,
    enabled: !separator,
    detail: EMPTY,
    role: "command",
    key: EMPTY,
    modifiers: noneModifiers(),
  };
}

export function statusItem(model: Model): StatusItemState {
  const cards = visibleCards(model);
  let best = 101;
  for (const c of cards) {
    if (c.status !== "ready") continue;
    for (const b of c.bars) {
      const usedRaw = b.usedPercent;
      const used = usedRaw >= 0 && usedRaw <= 100 ? Math.trunc(usedRaw) : usedRaw > 100 ? 100 : 0;
      const left = used >= 100 ? 0 : 100 - used;
      if (left < best) best = left >= 0 && left <= 100 ? Math.trunc(left) : 0;
    }
  }
  const title = best > 100 ? asciiBytes("QB") : asciiBytes(`${best}%`);
  const tone = best < 10 ? "critical" as const : best < 50 ? "warning" as const : "normal" as const;
  return {
    iconPath: EMPTY,
    tooltip: utf8Bytes("QuotaBar usage"),
    activationCommand: asciiBytes("app.open"),
    alternateActivationCommand: asciiBytes("app.settings"),
    openCommand: asciiBytes("app.open"),
    presentation: {
      title: title,
      width: 48,
      tone: tone,
      iconOpacity: 1,
      monospaced: true,
    },
    items: [
      menuRow(1, "Open panel", "app.open", false),
      menuRow(2, "Open Dashboard", "app.dashboard", false),
      menuRow(3, "Settings", "app.settings", false),
      menuRow(4, "Refresh", "app.refresh", false),
      menuRow(0, "", "", true),
      menuRow(5, "Quit", "app.quit", false),
    ],
  };
}

export function themeState(model: Model): ThemeState {
  return model.demoMode
    ? { pack: "geist", colorScheme: "system" }
    : { pack: "geist", colorScheme: "system" };
}

function dashboardWindow(): WindowDescriptor {
  return windowDescriptor({
    label: asciiBytes("dashboard"),
    canvasLabel: asciiBytes("dashboard-canvas"),
    title: asciiBytes("QuotaBar Dashboard"),
    width: 720,
    height: 720,
    resizable: true,
    minWidth: 560,
    minHeight: 480,
    titlebar: "chromeless",
    transparent: true,
    alwaysOnTop: false,
    clickThrough: false,
    activateOnShow: true,
    allowsFullscreen: false,
    closePolicy: "quit",
    onCloseCommand: asciiBytes("app.dashboard-closed"),
  });
}

function settingsWindow(): WindowDescriptor {
  return windowDescriptor({
    label: asciiBytes("settings"),
    canvasLabel: asciiBytes("settings-canvas"),
    title: asciiBytes("QuotaBar Settings"),
    width: 520,
    height: 640,
    resizable: true,
    minWidth: 420,
    minHeight: 480,
    titlebar: "chromeless",
    transparent: true,
    alwaysOnTop: false,
    clickThrough: false,
    activateOnShow: true,
    allowsFullscreen: false,
    closePolicy: "quit",
    onCloseCommand: asciiBytes("app.settings-closed"),
  });
}

export function windows(model: Model): readonly WindowDescriptor[] {
  if (model.dashboardOpen && model.settingsOpen) {
    return [dashboardWindow(), settingsWindow()];
  }
  if (model.dashboardOpen) {
    return [dashboardWindow()];
  }
  if (model.settingsOpen) {
    return [settingsWindow()];
  }
  return [];
}

export type { ErrorKind, ProviderId, ProviderStatus, QuotaWindow };

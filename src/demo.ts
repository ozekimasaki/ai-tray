// デモ用フィクスチャ。ネットワークなしで 9 カードの見た目を確認する。
// i64 スロットはリテラルか、比較で狭めたあとの Math.trunc だけを載せる。

import { asciiBytes, utf8Bytes } from "@native-sdk/core";
import { type AuthSource, type ProviderId, type ProviderState, type QuotaWindow } from "./snapshot.ts";

function resetMs(nowMs: number, extraMs: number): number {
  if (nowMs >= 0 && nowMs <= 9007199254740991) return Math.trunc(nowMs) + extraMs;
  return extraMs;
}

function bar(id: number, title: string, used: number, resetsAtMs: number): QuotaWindow {
  const safeId = id >= 0 && id <= 100 ? Math.trunc(id) : 0;
  const safeUsed = used >= 0 && used <= 100 ? Math.trunc(used) : used > 100 ? 100 : 0;
  const safeReset = resetsAtMs >= 0 && resetsAtMs <= 9007199254740991 ? Math.trunc(resetsAtMs) : 0;
  return {
    id: safeId,
    title: asciiBytes(title),
    usedPercent: safeUsed,
    resetsAtMs: safeReset,
    isCount: false,
    remaining: 0,
  };
}

function countBar(id: number, title: string, remaining: number): QuotaWindow {
  const safeId = id >= 0 && id <= 100 ? Math.trunc(id) : 0;
  const safeRemaining = remaining >= 0 && remaining <= 9007199254740991 ? Math.trunc(remaining) : 0;
  return {
    id: safeId,
    title: asciiBytes(title),
    usedPercent: 0,
    resetsAtMs: 0,
    isCount: true,
    remaining: safeRemaining,
  };
}

function ready(
  id: ProviderId,
  slot: number,
  plan: string,
  account: string,
  windows: readonly QuotaWindow[],
  source: AuthSource,
): ProviderState {
  const safeSlot = slot >= 0 && slot <= 8 ? Math.trunc(slot) : 0;
  return {
    id: id,
    slot: safeSlot,
    enabled: true,
    source: source,
    status: "ready",
    account: utf8Bytes(account),
    plan: asciiBytes(plan),
    windows: windows,
    errorKind: "none",
    errorText: asciiBytes(""),
    fetchedAtMs: 1,
    credentialPresent: false,
    stale: false,
  };
}

/** nowMs 基準でリセット時刻を載せる。初回 tick 後に呼ぶ。 */
export function demoProviders(nowMs: number): readonly ProviderState[] {
  const sessionExtra = 2 * 3600 * 1000 + 14 * 60 * 1000;
  const weeklyExtra = 3 * 24 * 3600 * 1000;
  const monthExtra = 12 * 24 * 3600 * 1000;
  const sessionReset = resetMs(nowMs, sessionExtra);
  const weeklyReset = resetMs(nowMs, weeklyExtra);
  const monthReset = resetMs(nowMs, monthExtra);
  return [
    ready("claude", 0, "Pro", "claude-code", [
      bar(1, "Session", 32, sessionReset),
      bar(2, "Weekly", 18, weeklyReset),
    ], "auto"),
    ready("codex", 1, "Plus", "chatgpt", [
      bar(1, "Primary", 71, sessionReset),
      bar(2, "Secondary", 24, weeklyReset),
    ], "auto"),
    ready("cursor", 2, "Pro", "cursor-app", [
      bar(1, "Cursor", 12, monthReset),
      bar(2, "Other", 44, monthReset),
      bar(3, "Grok", 18, weeklyReset),
    ], "auto"),
    ready("antigravity", 3, "Google", "agy", [bar(1, "Weekly", 27, weeklyReset)], "auto"),
    ready("gemini", 4, "Free", "gemini-cli", [bar(1, "Daily", 55, sessionReset)], "auto"),
    ready("opencode", 5, "Zen", "opencode", [
      bar(1, "Session", 9, sessionReset),
      bar(2, "Weekly", 41, weeklyReset),
    ], "auto"),
    ready("alibaba", 6, "Coding Plan", "intl", [
      bar(1, "Session", 22, sessionReset),
      bar(2, "Weekly", 61, weeklyReset),
      bar(3, "Monthly", 14, monthReset),
    ], "auto"),
    ready("kie", 7, "Credits", "kie.ai", [countBar(1, "Credits", 128)], "api"),
    ready("devin", 8, "Daily/Weekly", "org_demo", [
      bar(1, "Daily", 22, sessionReset),
      bar(2, "Weekly", 61, weeklyReset),
    ], "api"),
  ];
}

function emptyDemoWindows(): readonly QuotaWindow[] {
  const items: QuotaWindow[] = [];
  return items;
}

function slotOf(id: ProviderId): number {
  switch (id) {
    case "claude":
      return 0;
    case "codex":
      return 1;
    case "cursor":
      return 2;
    case "antigravity":
      return 3;
    case "gemini":
      return 4;
    case "opencode":
      return 5;
    case "alibaba":
      return 6;
    case "kie":
      return 7;
    case "devin":
      return 8;
  }
}

export function emptyProvider(id: ProviderId, enabled: boolean): ProviderState {
  const rawSlot = slotOf(id);
  const slot = rawSlot >= 0 && rawSlot <= 8 ? Math.trunc(rawSlot) : 0;
  const source: AuthSource = id === "kie" || id === "devin" ? "api" : "auto";
  return {
    id: id,
    slot: slot,
    enabled: enabled,
    source: source,
    status: "idle",
    account: asciiBytes(""),
    plan: asciiBytes(""),
    windows: emptyDemoWindows(),
    errorKind: "none",
    errorText: asciiBytes(""),
    fetchedAtMs: 0,
    credentialPresent: false,
    stale: false,
  };
}

export const PROVIDER_ORDER: readonly ProviderId[] = [
  "claude",
  "codex",
  "cursor",
  "antigravity",
  "gemini",
  "opencode",
  "alibaba",
  "kie",
  "devin",
];

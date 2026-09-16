// デモ用フィクスチャ。ネットワークなしで 7 カードの見た目を確認する。

import { asciiBytes, utf8Bytes } from "@native-sdk/core";
import { type ProviderId, type ProviderState, type QuotaWindow } from "./snapshot.ts";

function bar(id: number, title: string, used: number, resetsAtMs: number): QuotaWindow {
  return {
    id: id,
    title: asciiBytes(title),
    usedPercent: used,
    resetsAtMs: resetsAtMs,
  };
}

function ready(
  id: ProviderId,
  slot: number,
  plan: string,
  account: string,
  windows: readonly QuotaWindow[],
): ProviderState {
  return {
    id: id,
    slot: slot,
    enabled: true,
    source: "auto",
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
  const sessionReset = nowMs + 2 * 3600 * 1000 + 14 * 60 * 1000;
  const weeklyReset = nowMs + 3 * 24 * 3600 * 1000;
  const monthReset = nowMs + 12 * 24 * 3600 * 1000;
  return [
    ready("claude", 0, "Pro", "claude-code", [
      bar(1, "Session", 32, sessionReset),
      bar(2, "Weekly", 18, weeklyReset),
    ]),
    ready("codex", 1, "Plus", "chatgpt", [
      bar(1, "Primary", 71, sessionReset),
      bar(2, "Secondary", 24, weeklyReset),
    ]),
    ready("cursor", 2, "Pro", "cursor-app", [
      bar(1, "Plan", 44, monthReset),
      bar(2, "Cursor", 12, monthReset),
      bar(3, "Grok Bot", 18, weeklyReset),
    ]),
    ready("antigravity", 3, "Google", "agy", [bar(1, "Weekly", 27, weeklyReset)]),
    ready("gemini", 4, "Free", "gemini-cli", [bar(1, "Daily", 55, sessionReset)]),
    ready("opencode", 5, "Zen", "opencode", [
      bar(1, "Session", 9, sessionReset),
      bar(2, "Weekly", 41, weeklyReset),
    ]),
    ready("alibaba", 6, "Coding Plan", "intl", [
      bar(1, "Session", 22, sessionReset),
      bar(2, "Weekly", 61, weeklyReset),
      bar(3, "Monthly", 14, monthReset),
    ]),
  ];
}

export function emptyProvider(id: ProviderId, slot: number, enabled: boolean): ProviderState {
  return {
    id: id,
    slot: slot,
    enabled: enabled,
    source: "auto",
    status: "idle",
    account: asciiBytes(""),
    plan: asciiBytes(""),
    windows: [],
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
];

// 整数域の表示ヘルパ。テンプレート穴は整数のみ（NS1016）。

import { asciiBytes } from "@native-sdk/core";

export function concat2(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function concat3(a: Uint8Array, b: Uint8Array, c: Uint8Array): Uint8Array {
  return concat2(concat2(a, b), c);
}

/** 正の整数除算。ホスト時刻のような f64 でも整数ステップで割る。 */
export function intDiv(n: number, d: number): number {
  if (d <= 0) return 0;
  let q = 0;
  let r = n;
  while (r >= d) {
    let step = d;
    let count = 1;
    while (step + step <= r) {
      step += step;
      count += count;
    }
    r -= step;
    q += count;
  }
  if (q >= 0) return Math.trunc(q);
  return 0;
}

export function clampPercent(n: number): number {
  if (n >= 0 && n <= 100) return Math.trunc(n);
  if (n > 100) return 100;
  return 0;
}

/** permille (0..1000) を 0..1 の fraction にする。progress 用。 */
export function permilleFraction(permille: number): number {
  let out = 0;
  let rest = permille;
  if (rest > 1000) rest = 1000;
  if (rest < 0) rest = 0;
  while (rest >= 1) {
    rest -= 1;
    out += 0.001;
  }
  return out;
}

export function percentLeft(usedPercent: number): number {
  const used = clampPercent(usedPercent);
  if (used >= 100) return 0;
  return 100 - used;
}

export function formatAgo(nowMs: number, thenMs: number): Uint8Array {
  if (thenMs <= 0) return asciiBytes("Waiting for first refresh");
  const delta = nowMs < thenMs ? 0 : nowMs - thenMs;
  const sec = intDiv(delta, 1000);
  if (sec < 5) return asciiBytes("Updated just now");
  if (sec < 60) return asciiBytes(`Updated ${sec}s ago`);
  const min = intDiv(sec, 60);
  if (min < 60) return asciiBytes(`Updated ${min}m ago`);
  const hours = intDiv(min, 60);
  return asciiBytes(`Updated ${hours}h ago`);
}

export function formatReset(nowMs: number, resetsAtMs: number): Uint8Array {
  // 再開時刻が無い窓（Claude の five_hour の未使用など）は行そのものを出さない。
  if (resetsAtMs <= 0) return asciiBytes("");
  if (resetsAtMs <= nowMs) return asciiBytes("Resets soon");
  const sec = intDiv(resetsAtMs - nowMs, 1000);
  if (sec < 60) return asciiBytes(`Resets in ${sec}s`);
  const min = intDiv(sec, 60);
  if (min < 60) return asciiBytes(`Resets in ${min}m`);
  const hours = intDiv(min, 60);
  const remMin = min - hours * 60;
  if (hours < 48) return asciiBytes(`Resets in ${hours}h ${remMin}m`);
  const days = intDiv(hours, 24);
  return asciiBytes(`Resets in ${days}d`);
}

export function leftLabel(usedPercent: number): Uint8Array {
  return asciiBytes(`${percentLeft(usedPercent)}% left`);
}

/** 残高整数のラベル。上限が無いのでパーセントにしない。 */
export function creditsLabel(remaining: number): Uint8Array {
  const n = remaining >= 0 && remaining <= 9007199254740991 ? Math.trunc(remaining) : 0;
  return asciiBytes(`${n} credits`);
}

export function intervalLabel(sec: number): Uint8Array {
  return asciiBytes(`Every ${sec}s`);
}

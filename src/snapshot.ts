// コアとサービスが共有する境界型。秘密バイトは Model に残さない。
// Model に載せるレコードは interface（参照）。サービス境界は type エイリアス。

/** 監視する 9 プロバイダ。並びはカード表示順。devin は slot 8。 */
export type ProviderId =
  | "claude"
  | "codex"
  | "cursor"
  | "antigravity"
  | "gemini"
  | "opencode"
  | "alibaba"
  | "kie"
  | "devin";

/** 資格情報の取り方。auto はファイル→手動の順。 */
export type AuthSource = "auto" | "oauth" | "cli" | "cookie" | "api";

export type ProviderStatus = "idle" | "loading" | "ready" | "missing" | "failed";

export type ErrorKind = "none" | "auth" | "network" | "not_found" | "migrated" | "unknown";

export type AlibabaRegion = "intl" | "cn";

/** サービスが読むローカル資格情報ファイル。 desktop / agent は Windows を含む複数候補。 */
export type PathKind =
  | "claude"
  | "claude_desktop"
  | "codex"
  | "cursor"
  | "cursor_agent"
  | "antigravity_db"
  | "gemini";

export type PathRequest = {
  readonly kind: PathKind;
};

export type PathResult = {
  readonly kind: PathKind;
  readonly path: Uint8Array;
};

export type QuotaTone = "normal" | "warning" | "destructive";

/** quota 1 本。usedPercent は 0..100。isCount なら remaining が残高で usedPercent は 0。 */
export interface QuotaWindow {
  readonly id: number;
  readonly title: Uint8Array;
  readonly usedPercent: number;
  readonly resetsAtMs: number;
  readonly isCount: boolean;
  readonly remaining: number;
}

/** サービス境界用。配列は named record で包む。 */
export type ServiceWindow = {
  readonly id: number;
  readonly title: Uint8Array;
  readonly usedPercent: number;
  readonly resetsAtMs: number;
  readonly isCount: boolean;
  readonly remaining: number;
};

export type QuotaWindows = {
  readonly items: readonly ServiceWindow[];
};

export interface ProviderState {
  readonly id: ProviderId;
  readonly slot: number;
  readonly enabled: boolean;
  readonly source: AuthSource;
  readonly status: ProviderStatus;
  readonly account: Uint8Array;
  readonly plan: Uint8Array;
  readonly windows: readonly QuotaWindow[];
  readonly errorKind: ErrorKind;
  readonly errorText: Uint8Array;
  readonly fetchedAtMs: number;
  readonly credentialPresent: boolean;
  readonly stale: boolean;
}

export type FetchOneRequest = {
  readonly id: ProviderId;
  readonly source: AuthSource;
  readonly region: AlibabaRegion;
  readonly secret: Uint8Array;
  readonly nowMs: number;
};

/** サービスは throw せずこのレコードを返す。ok=false が業務エラー。 */
export type FetchOneResult = {
  readonly ok: boolean;
  readonly id: ProviderId;
  readonly account: Uint8Array;
  readonly plan: Uint8Array;
  readonly windows: QuotaWindows;
  readonly errorKind: ErrorKind;
  readonly errorText: Uint8Array;
  readonly fetchedAtMs: number;
};

export interface CardBar {
  readonly id: number;
  readonly title: Uint8Array;
  readonly usedPercent: number;
  readonly leftPercent: number;
  readonly usedFraction: number;
  readonly leftLabel: Uint8Array;
  readonly resetLabel: Uint8Array;
  readonly hasReset: boolean;
  readonly tone: QuotaTone;
  readonly isCount: boolean;
  readonly remaining: number;
}

/** カード横断のバー行。ネスト each が使えないので slot で絞る。 */
export interface FlatBar {
  readonly id: number;
  readonly slot: number;
  readonly title: Uint8Array;
  readonly usedPercent: number;
  readonly leftPercent: number;
  readonly usedFraction: number;
  readonly leftLabel: Uint8Array;
  readonly resetLabel: Uint8Array;
  readonly hasReset: boolean;
  readonly tone: QuotaTone;
  readonly isCount: boolean;
  readonly remaining: number;
}

export interface CardView {
  readonly id: number;
  readonly slot: number;
  readonly name: Uint8Array;
  readonly plan: Uint8Array;
  readonly sourceBadge: Uint8Array;
  readonly status: ProviderStatus;
  readonly account: Uint8Array;
  readonly errorText: Uint8Array;
  readonly hint: Uint8Array;
  readonly stale: boolean;
  readonly bars: readonly CardBar[];
}

export interface SettingsRow {
  readonly id: number;
  readonly slot: number;
  readonly name: Uint8Array;
  readonly enabled: boolean;
  readonly sourceLabel: Uint8Array;
  readonly regionLabel: Uint8Array;
  readonly showRegion: boolean;
  readonly credentialPresent: boolean;
  readonly hint: Uint8Array;
}

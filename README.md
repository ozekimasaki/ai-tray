# QuotaBar

Windows 向けのトレイ常駐 AI 利用量モニタです。Claude / Codex / Cursor / Antigravity / Gemini / OpenCode / Alibaba Coding Plan の 7 ソースを、ローカル CLI セッション・手動 Cookie・API キーから読みます。エンジンは [Native SDK](https://github.com/vercel-labs/native)（Zig + TypeScript コア、WebView なし）です。

画面の文言は英語です。同梱フォントは Geist Regular / Geist Mono だけで、CJK グリフが無いため日本語を置くと tofu になります。

## できること

- 半透明の chromeless 窓（外側はデスクトップが透ける。内側は surface のベール）
- トレイ（Windows）: 残りが最少のパーセント、左クリックでコンパクト窓、Quit で終了
- Compact / Dashboard / Settings の 3 窓
- 初回は Demo data（ネットワークなし）。Settings で切ると実データを取る
- Cursor カードの追加バー **Grok Bot**（`get-sand-usage-status`。xAI 単体課金ではない）

対象外: ブラウザ Cookie の自動復号、コストログ、マルチアカウント、Alibaba Token Plan、xAI 単体の Grok。

## 必要環境

- Node.js 24（Native SDK の frontend / scriptc。出荷バイナリには入らない）
- Native SDK CLI 0.9.3: `npm install -g @native-sdk/cli`
- Zig は CLI が用意する
- Linux で `native dev` するとき: GTK4 開発パッケージ（Ubuntu なら `libgtk-4-dev`）
- 実データ取得時: `curl`（HTTPS）、Cursor は `sqlite3`（`state.vscdb` を read-only）、Antigravity は `agy`

再現可能なシェルは jetify Devbox です。

```sh
devbox shell
devbox run setup    # CLI を入れる（初回）
devbox run check
devbox run dev
```

Devbox が無い場合:

```sh
npm install -g @native-sdk/cli
native check
native dev
```

`package.json` はエディタ用です。ビルドは `native` が SDK を解決するので `npm install` は必須ではありません。

## 使い方

1. 起動すると compact 窓に 7 枚の Demo カードが出ます。
2. Settings でプロバイダの ON/OFF、ソース（auto / oauth / cli / cookie / api）、Alibaba の intl/cn、更新間隔を変えます。
3. Demo data を切ると、次の Refresh でローカル資格情報を読みます。
4. API キーや Cookie は Settings の secret 欄へ。OS の Credential Manager に入り、persist には乗りません。
5. Close は窓を隠すだけです。終了はトレイの Quit、または Linux 開発時のヘッダー Quit。

### 各プロバイダのログイン

| プロバイダ | 自動で読むもの | 手動 |
| --- | --- | --- |
| Claude | `~/.claude/.credentials.json` の OAuth。`GET api.anthropic.com/api/oauth/usage` | session cookie |
| Codex | `~/.codex/auth.json` または `$CODEX_HOME/auth.json`。`GET chatgpt.com/backend-api/wham/usage` | — |
| Cursor | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` の `cursorAuth/accessToken`（期限切れは使わない） | `WorkosCursorSessionToken` または Cookie ヘッダ |
| Antigravity | PATH の `agy -p /usage --output-format json`。失敗時は Gemini OAuth | — |
| Gemini | `~/.gemini/oauth_creds.json`。期限切れは Gemini CLI の公開クライアントで refresh。個人向け廃止は Antigravity へ誘導 | — |
| OpenCode | なし | Zen API キー、または opencode.ai の Cookie |
| Alibaba | なし | Model Studio API キー優先、次にコンソール Cookie。Region で intl/cn |

Cursor の Grok Bot は usage-summary のあとに best-effort で `POST https://cursor.com/api/dashboard/get-sand-usage-status` します。失敗しても Plan / Cursor バーは残します。

## Windows 向けパッケージ

Linux ではトレイが無いので、このリポジトリの `app.zon` は main 窓を最初から表示し、`close_policy = hide` は付けていません（Linux ビルドが拒否するため）。Windows ではトレイが復帰手段です。chromeless の Close は `Cmd.hideWindow`、Quit はトレイだけ、という動きになります。

```sh
native package --target windows
```

または `devbox run package-windows`。成果物の使い方は Native SDK の `native package --help` を見てください。

Windows でトレイ常駐にするには、パッケージ後にアプリを起動したまま compact を Close してください。タスクバーには出ず、トレイのパーセント（データが無ければ `QB`）から戻ります。

## Linux での開発

この環境ではトレイを検証できません。compact は最初から見え、ヘッダーに Quit があります。確認すること:

- 窓の外側からデスクトップが見える（transparent + premultiplied）
- カードは半透明ベール
- フォントが Geist
- 文言が英語で tofu が無い
- Demo 7 カード、全オフの空状態、Settings の Preview error state
- Settings でプロバイダを消すと compact から消える
- Close でプロセスが死なない（hide）。終了は Quit

Linux では GTK4 がリンクされます。Ubuntu なら `sudo apt install libgtk-4-dev`。Devbox なら `gtk4` パッケージを入れたうえで `devbox run dev`。

```sh
native dev
```

ロジックだけなら `native dev --core`（レンダラなし）。

## レイアウト

- `app.zon` — アプリ ID `dev.quotabar.app`、Windows/Linux、tray / persist / credentials、fetch allowlist
- `src/core.ts` — Model / Msg / update / subscriptions / statusItem / windows
- `src/app.native` — compact
- `src/windows/dashboard.native` / `settings.native`
- `src/services/usage.ts` — `fetchOne`（同期。curl / sqlite3 / agy）
- `src/demo.ts` — デモ 7 カード

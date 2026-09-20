# QuotaBar

Windows / macOS / Linux 向けのトレイ常駐 AI 利用量モニタです。Claude / Codex / Cursor / Antigravity / Gemini / OpenCode / Alibaba Coding Plan / Kie / Devin の 9 ソースを、ローカル CLI セッション・手動 Cookie・API キーから読みます。エンジンは [Native SDK](https://github.com/vercel-labs/native)（Zig + TypeScript コア、WebView なし）です。

画面の文言は英語です。同梱フォントは Geist Regular / Geist Mono だけで、CJK グリフが無いため日本語を置くと tofu になります。

## できること

- 半透明の chromeless 窓（外側はデスクトップが透ける。内側は surface のベール）
- トレイ: 残りが最少のパーセント。Windows は通知領域、macOS はメニューバー extra（`NSStatusItem`）。左クリックで compact、Quit で終了
- Compact / Dashboard / Settings の 3 窓
- 初回は Demo data（ネットワークなし）。Settings で切ると実データを取る
- Cursor カードは **Cursor / Other / Grok**（`usage-summary` の auto/api プールと、任意の `get-sand-usage-status`。xAI 単体課金ではない）
- Kie カードは残クレジット整数（`GET api.kie.ai/api/v1/chat/credit`。上限が無いのでプログレスバーは出さない）
- Devin カードは Daily / Weekly（`GET app.devin.ai/.../billing/quota/usage`。org id と Bearer を Settings に貼る）

対象外: ブラウザ Cookie の自動復号、Chrome localStorage、コストログ、マルチアカウント、Alibaba Token Plan、xAI 単体の Grok、Devin Desktop、enterprise の 10/hr。

## 必要環境

- Node.js 24（Native SDK の frontend / scriptc。出荷バイナリには入らない）
- Native SDK CLI 0.9.3: `npm install -g @native-sdk/cli@0.9.3` または `bun install -g @native-sdk/cli@0.9.3`
- Zig 0.16.0。macOS / Linux では CLI が `~/.native/toolchains/` に入れる。**Windows では CLI が Zig をダウンロードできない**（アーカイブ表が macOS / Linux だけ）ので、自分で入れる
- macOS 11.0 以上（`.app` のビルドは **Mac 上** で行う。Linux からはクロスコンパイルできない）
- Linux で `native dev` するとき: GTK4 開発パッケージ（Ubuntu なら `libgtk-4-dev`）
- 実データ取得時: `curl`（HTTPS。Windows 10 以降は `curl.exe` あり）、Cursor は `sqlite3`（`state.vscdb` を read-only。macOS は `/usr/bin/sqlite3` が標準、Windows は別途入れる）、Antigravity は `agy`

jetify Devbox は **Linux / macOS、および Windows 上の WSL2** 向けです。ネイティブ Windows では Nix が無いので `devbox.json` は使えません。Windows は下の「Windows での開発」を見てください。WSL で Devbox を回しても Linux GTK ビルドになり、通知領域トレイや Direct2D は検証できません。

Linux / macOS の再現シェル:

```sh
devbox shell
devbox run setup    # CLI を入れる（初回）
devbox run check
devbox run dev
```

Devbox が無い Linux / macOS:

```sh
npm install -g @native-sdk/cli@0.9.3
native check
native dev
```

`package.json` はエディタ用です。ビルドは `native` が SDK を解決するので `npm install` は必須ではありません。

## 使い方

1. 起動するとパネルに 9 枚の Demo カードが出ます。
2. Settings でプロバイダの ON/OFF、ソース（auto / oauth / cli / cookie / api）、Alibaba の intl/cn、更新間隔を変えます。
3. Demo data を切ると、次の Refresh でローカル資格情報を読みます。
4. API キーや Cookie は Settings の secret 欄へ。Windows は Credential Manager、macOS は Keychain、Linux は Secret Service。persist には乗りません。
5. Close は compact GPU 窓を破棄します。終了はトレイ（Windows / macOS）の Quit、または Settings の Quit。

### 各プロバイダのログイン

| プロバイダ | 自動で読むもの | 手動 |
| --- | --- | --- |
| Claude | `~/.claude/.credentials.json` の OAuth。`GET api.anthropic.com/api/oauth/usage` | session cookie |
| Codex | `~/.codex/auth.json` または `$CODEX_HOME/auth.json`。`GET chatgpt.com/backend-api/wham/usage` | — |
| Cursor | `state.vscdb` の `cursorAuth/accessToken`（期限切れは使わない）。Windows は `%APPDATA%\Cursor\...`、macOS は `~/Library/Application Support/Cursor/...`、Linux は `~/.config/Cursor/...` | `WorkosCursorSessionToken` または Cookie ヘッダ |
| Antigravity | PATH の `agy -p /usage --output-format json`。失敗時は Gemini OAuth | — |
| Gemini | `~/.gemini/oauth_creds.json`。期限切れは Gemini CLI の公開クライアントで refresh。個人向け廃止は Antigravity へ誘導 | — |
| OpenCode | なし | Zen API キー、または opencode.ai の Cookie |
| Alibaba | なし | Model Studio API キー優先、次にコンソール Cookie。Region で intl/cn |
| Kie | なし | kie.ai API キー。`GET /api/v1/chat/credit` の残クレジット（パーセント枠ではない。リセットなし） |
| Devin | なし | `org_id` と Bearer。2 行、`org_id:token`、またはヘッダ貼り付け。`GET app.devin.ai/api/<org>/billing/quota/usage` |

Cursor の Grok は usage-summary のあとに best-effort で `POST https://cursor.com/api/dashboard/get-sand-usage-status` します。失敗しても Cursor / Other バーは残します。

## パッケージ（Windows / macOS）

Linux ではトレイが無いので Close すると戻る手段がありません（GTK は `close_policy = hide` を拒否します）。Windows と macOS ではトレイ（通知領域 / メニューバー extra）が復帰手段です。パネルの Close は GPU 窓を破棄します（隠したまま回さない）。macOS は `dock_visible = false`（`LSUIElement`）なので Dock には出ません。Quit はトレイ、または Settings です。

Windows では Devbox は不要です。先に `native build` してから包みます（Git Bash / PowerShell 例は「Windows での開発」）。

```sh
SCRIPTC_CC=zigcc native build
SCRIPTC_CC=zigcc native package --target windows
```

成果物はディレクトリ（exe + アイコン + assets）。MSI / MSIX は出ません。`--signing` は **macOS 専用**（`none` / `adhoc` / `identity`）。Windows の Authenticode は Native SDK 0.9.3 に無いので、配布 exe は SmartScreen に引っかかります。`signtool` は手元で別途です。

Linux / macOS で Devbox を使っているときだけ `devbox run package-windows` / `devbox run package-macos` でも同じです。macOS の `.app` / DMG は **macOS ホストで** 作ってください。Linux 上の `native package --target macos` は失敗します。成果物の使い方は Native SDK の `native package --help` を見てください。

macOS を配布するときは署名を付けます。

```sh
native package --target macos --signing identity --identity "Developer ID Application: Your Name" --archive
```

ローカル確認だけなら `--signing adhoc`（または `none`）。Gatekeeper は adhoc を開発用として扱います。最低 OS は macOS 11.0 です。Linux 上で `--signing none` しても、包むバイナリは Linux 用なので Mac では動きません。

Windows / macOS では Compact を Close すると GPU 窓は破棄され、トレイのパーセント（データが無ければ `QB`）だけが残ります。次の起動もその状態を persist します。パネルを出すのはトレイの Open panel です。

## Windows での開発

ネイティブ Windows（x64）で開発・実行・パッケージします。WSL は不要です。Zig 0.16.0 の `aarch64-windows` は上流が壊れているので ARM マシンは対象外です。

`native` は WinGet のパッケージ名ではない。PowerShell が Diskuv.OCaml などを提案しても **入れない**。入れるのは npm の `@native-sdk/cli@0.9.3`（コマンドは `native.cmd`）。

1. [Node.js 24](https://nodejs.org/)（scriptc が `node` を呼ぶ）。`npm` が無いなら先にこれ。CLI だけ Bun で入れても Node 24 は PATH に残す
2. Zig 0.16.0。CLI は Windows 向けアーカイブを持たないので、[mise](https://mise.jdx.dev/) か [ziglang.org](https://ziglang.org/download/) の `zig-x86_64-windows-0.16.0.zip` を PATH へ。Visual Studio / clang は `SCRIPTC_CC=zigcc` なら不要
3. Native SDK CLI 0.9.3（下の PowerShell / Git Bash）。Bun なら `bun install -g @native-sdk/cli@0.9.3`（`%USERPROFILE%\.bun\bin` を PATH へ）
4. 実データの Cursor 用に `sqlite3`（`winget install SQLite.SQLite` など。これは sqlite 用で、`native` 用ではない）。`curl` は Windows 10 以降に付属。Antigravity は `agy`

Git Bash（CLI をグローバルに入れたあと）:

```sh
export SCRIPTC_CC=zigcc
native dev                         # Debug。スクロールは遅い
native build                       # ReleaseFast → zig-out/bin/quotabar.exe
native package --target windows    # 上の exe をディレクトリに包む
```

PowerShell。先に CLI を入れて、同じセッションの PATH を更新する。`$env:SCRIPTC_CC` だけでは `native` は増えない。

```powershell
npm i -g @native-sdk/cli@0.9.3
$env:Path = "$env:APPDATA\npm;" + [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "Machine")
Get-Command native   # C:\Users\<you>\AppData\Roaming\npm\native.cmd が見えること

$env:SCRIPTC_CC = "zigcc"
native dev
native build
native package --target windows
```

`native` がまだ無い／入れたくないときは `npx`（グローバル PATH 不要）:

```powershell
$env:SCRIPTC_CC = "zigcc"
npx --yes @native-sdk/cli@0.9.3 dev
npx --yes @native-sdk/cli@0.9.3 build
npx --yes @native-sdk/cli@0.9.3 package --target windows
```

`native check` は Windows では壊れます（バックスラッシュパスを `/` 専用の import resolver に渡す）。代わりにスラッシュで:

```sh
native markup check src/windows/compact.native src/windows/dashboard.native src/windows/settings.native src/app.native src/windows/components/title-bar.native src/windows/components/provider-card.native
```

ホイールの慣性をブラウザ風にするパッチは `tools/patch-native-sdk-scroll.sh`（CLI 再インストール後に再実行）。パスは Bun グローバル前提です。npm グローバルなら `tokens.zig` の場所を合わせてください。

実データの Cursor は `%APPDATA%\Cursor\User\globalStorage\state.vscdb`。トレイのパーセント（データが無ければ `QB`）からパネルを出します。

## macOS での開発

`native dev` を Mac 上で実行します。メニューバー extra にパーセント（データが無ければ `QB`）が出ます。パネルは `windows(model)` の compact 二次窓です。Close すると GPU 面を破棄してトレイに戻ります。終了は extra の Quit、または Settings の Quit。実データの Cursor は `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`。`curl` と `sqlite3` は macOS 標準です。`agy` は PATH へ入れてください。

この Linux 環境では `.app` の起動もメニューバー extra も検証していません。

## Linux での開発

この環境ではトレイを検証できません。初回は compact が見えます。確認すること:

- 窓の外側からデスクトップが見える（transparent + premultiplied）
- カードは半透明ベール
- フォントが Geist
- 文言が英語で tofu が無い
- Demo 9 カード、全オフの空状態、Settings の Preview error state
- Settings でプロバイダを消すとパネルから消える
- Close でプロセスが死なない（compact GPU を破棄する。Linux にはトレイが無いので戻る手段は無い）。終了は Settings の Quit

Linux では GTK4 がリンクされます。Ubuntu なら `sudo apt install libgtk-4-dev`。Devbox なら `gtk4` パッケージを入れたうえで `devbox run dev`。

```sh
native dev
```

ロジックだけなら `native dev --core`（レンダラなし）。

## レイアウト

- `app.zon` — アプリ ID `dev.quotabar.app`、Windows/macOS/Linux、tray / persist / credentials、fetch allowlist
- `src/core.ts` — Model / Msg / update / subscriptions / statusItem / windows
- `src/app.native` — 隠した GPU ホスト（空）
- `src/windows/compact.native` — トレイパネル（二次 GPU。Close で破棄）
- `src/windows/dashboard.native` / `settings.native`
- `src/services/usage.ts` — `fetchOne`（同期。curl / sqlite3 / agy）
- `src/demo.ts` — デモ 9 カード

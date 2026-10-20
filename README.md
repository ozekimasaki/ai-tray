# QuotaBar

Windows 専用のトレイ常駐 AI 利用量モニタです。Claude / Codex / Cursor の残量を、通知領域のアイコンと小さいパネルの**バー**で出します。

エンジンは **Rust + 生の Win32**（GDI）です。WebView2 / Tauri / Electron / .NET / Native SDK は使いません。macOS / Linux GUI は対象外です。

画面の文言は英語です。

## できること

- 通知領域のトレイアイコン。左クリックでコンパクトパネル、右クリックでメニュー
- パネルは使用量バー（残量パーセント）。Close はパネルを隠すだけで、終了はトレイの Quit
- 初回は Demo data（ネットワークなし）。トレイメニューの Demo data を外すとローカル資格情報を読む
- Codex は `~/.codex/auth.json`（現状 Windows で動く前提）
- Cursor は `%APPDATA%\Cursor\...\state.vscdb`（sqlite 同梱。ロック時はコピー / JWT スキャン）。`cursor-agent` の `auth.json` も読む
- Claude は `~/.claude/.credentials.json`、なければ Claude デスクトップの `config.json`（`oauth:tokenCacheV2`。Windows は DPAPI + AES-GCM）

対象外（この骨格）: Antigravity / Gemini / OpenCode / Alibaba / Kie / Devin、手動 Cookie 欄、Dashboard 窓。

## 必要環境

- Windows 10 以降（x64）。実データの HTTPS は付属の `curl.exe`
- 開発: Rust 1.83+（[MSVC](https://rustup.rs/) か GNU）
- Visual Studio / WebView2 Runtime / Node / Zig は不要

## 使い方

1. `quotabar.exe` を起動すると通知領域にアイコンが出ます。
2. 左クリックでパネル。Demo カード 3 枚（Claude / Codex / Cursor）とバー。
3. 右クリック → Demo data を外して Refresh。ローカルの CLI / アプリ資格情報を読みます。
4. Close（×）はパネルだけ隠します。終了は Quit。

## ビルド

Windows（MSVC、実機）:

```powershell
cargo test
cargo build --release
# target\release\quotabar.exe
```

Linux からのクロスコンパイル（このリポジトリの CI/エージェント向け）:

```sh
rustup target add x86_64-pc-windows-gnu
sudo apt install mingw-w64
cargo test                          # 使用量パーサ（Win32 GUI は含まない）
cargo build --release --target x86_64-pc-windows-gnu
# target/x86_64-pc-windows-gnu/release/quotabar.exe
```

配布は exe 単体（MSI なし）。Authenticode は別途。

## レイアウト

- `src/ui.rs` — トレイ、コンパクトパネル、GDI のバー
- `src/providers/` — Codex / Cursor / Claude の読み取り（旧 TypeScript サービスを移植）
- `src/paths.rs` — `%APPDATA%` / `%USERPROFILE%` を列挙。Git Bash の `/c/Users` も正規化
- 設定は `%APPDATA%\QuotaBar\settings.json`

アイドル時は隠れメッセージ窓とトレイだけです。パネルを閉じると GDI 面は描画しません。

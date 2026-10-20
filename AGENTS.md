# QuotaBar — agent notes

## スタック

Windows 専用。Rust + 生 Win32（`windows` 0.58、GDI）。WebView2 / Tauri / Electron / .NET / Native SDK / Mac GUI は使わない。

## 開発

```powershell
cargo test
cargo build --release
```

クロス（Linux）:

```sh
rustup target add x86_64-pc-windows-gnu
# linker: x86_64-w64-mingw32-gcc（`.cargo/config.toml`）
cargo build --release --target x86_64-pc-windows-gnu
```

`cargo test` はパーサとパス解決だけ。トレイとパネルは Windows で `quotabar.exe` を実行する。

## 使用量

- HTTP は `curl.exe`（旧 `usage.ts` と同じ）。ureq は入れない（新しい idna/icu が rustc 1.83 で落ちる）。
- Codex: `%USERPROFILE%/.codex/auth.json` または `$CODEX_HOME`
- Cursor: `state.vscdb` を rusqlite bundled で読む。失敗時はファイルコピー、さらに JWT スキャン。`cursor-agent` の `auth.json`
- Claude: CLI の `.credentials.json`（期限切れは refreshToken）。デスクトップは `%APPDATA%\Claude\config.json` の `oauth:tokenCacheV2` を Local State の DPAPI キー + AES-256-GCM（v10）で復号
- サービスは throw せずカードの `status` / `error` を返す

## UI

- トレイ左クリックでパネル、右クリックでメニュー。メニューを左クリックでは出さない
- バーは整数パーセントの塗り（used / left）。`<progress>` も WebView も使わない
- Close は `ShowWindow(SW_HIDE)`。Quit だけプロセス終了
- Explorer 再起動は `TaskbarCreated` でアイコンを付け直す

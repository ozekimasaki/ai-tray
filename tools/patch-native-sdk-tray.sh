#!/bin/sh
# Windows のトレイ左クリックでパネルが開かない（ワンテンポ遅れる）問題の回避。
# installed SDK の webview2_host.cpp は NIN_SELECT（左クリック）の分岐で
# activation command を出すだけでなく showTrayMenu() も呼ぶ。showTrayMenu は
# TrackPopupMenu のネストループに入り、ランタイムのフレームポンプを止めて
# foreground を奪う。ここを右クリック / コンテキストメニューだけに限定する。
#
# 再適用: `bun install -g @native-sdk/cli` のあとに必ず実行し直す（在-place 編集）。
set -eu

HOST="${SCRIPTC_HOST_CPP:-$USERPROFILE/.bun/install/global/node_modules/@native-sdk/cli/src/platform/windows/webview2_host.cpp}"

if [ ! -f "$HOST" ]; then
  echo "not found: $HOST" >&2
  exit 1
fi

# 初回だけ素のコピーを残す（戻したいときは cp "$HOST.bak" "$HOST"）
if [ ! -f "$HOST.bak" ]; then
  cp "$HOST" "$HOST.bak"
  echo "backup: $HOST.bak"
fi

# 左クリック分岐の showTrayMenu(host, hwnd); だけを消す。対象は 1 箇所のはず。
PY=""
for cand in python3 python py; do
  if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
done
if [ -z "$PY" ]; then
  echo "needs python3 / python / py to edit in place" >&2
  exit 1
fi

"$PY" - "$HOST" <<'PY'
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    text = f.read()

needle = (
    "                    emitStatusCommand(host, hwnd, host->tray_activation_command);\n"
    "                    showTrayMenu(host, hwnd);\n"
)
repl = (
    "                    emitStatusCommand(host, hwnd, host->tray_activation_command);\n"
    "                    // patched by tools/patch-native-sdk-tray.sh: left click opens the panel only\n"
)

count = text.count(needle)
if count == 0:
    if "patched by tools/patch-native-sdk-tray.sh" in text:
        print("already patched")
        sys.exit(0)
    print("pattern not found — SDK changed? inspect the NIN_SELECT branch", file=sys.stderr)
    sys.exit(2)
if count > 1:
    print("unexpected: %d matches" % count, file=sys.stderr)
    sys.exit(2)

with open(path, "w", encoding="utf-8", newline="") as f:
    f.write(text.replace(needle, repl))
print("patched", path)
PY

grep -n -A 3 "NIN_SELECT" "$HOST" | head -12

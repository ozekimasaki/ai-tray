#!/bin/sh
# 60fps 化の切り分け: 連続ホイール（40ms 間隔）と通常ホイール（120ms 間隔）で
# フレーム間隔の分布を比べる。入力は実マウス（SendInput）、ログはアプリ自身の
# native-sdk.jsonl。automation の profile 行も拾う。
set -eu
REPO="C:/Users/masam/Documents/ai-tray"
LOG="C:/Users/masam/AppData/Local/dev.quotabar.app/Logs/native-sdk.jsonl"
TMP="C:/Users/masam/AppData/Local/Temp"

cd "$REPO"
(./zig-out/bin/quotabar.exe > "$TMP/qb-fps.log" 2>&1 &)
native automate wait > /dev/null 2>&1
native automate menu-command app.open > /dev/null 2>&1
sleep 2
native automate profile on > /dev/null 2>&1
sleep 1

mark() { node -e "const fs=require('fs');fs.writeFileSync('$TMP/qb-fps-mark.txt',String(fs.statSync('$LOG').size));"; }
analyze() {
  node -e "
const fs=require('fs');
const mark=Number(fs.readFileSync('$TMP/qb-fps-mark.txt','utf8'));
const len=fs.statSync('$LOG').size-mark;
const fd=fs.openSync('$LOG','r'); const buf=Buffer.alloc(len); fs.readSync(fd,buf,0,len,mark); fs.closeSync(fd);
const evs=[];
for(const l of buf.toString('utf8').trim().split('\n')){ const m=l.match(/timestamp_ns\":(\d+).*?event\":\"([a-z_.]+)/); if(m) evs.push([Number(m[1]),m[2]]); }
const t0=evs.length?evs[0][0]:0;
const fr=evs.filter(e=>e[1]==='gpu_surface_frame').map(e=>(e[0]-t0)/1e6);
const sc=evs.filter(e=>e[1]==='canvas_widget_scroll').map(e=>(e[0]-t0)/1e6);
const g=[]; for(let i=1;i<fr.length;i++) g.push(fr[i]-fr[i-1]);
g.sort((a,b)=>a-b);
const p=(q)=>g.length?g[Math.min(g.length-1,Math.floor(g.length*q))].toFixed(1):'n/a';
const lat=[]; for(const s of sc){ const nx=fr.find(f=>f>=s); if(nx!==undefined) lat.push(nx-s); }
lat.sort((a,b)=>a-b);
console.log('$1', 'scrolls', sc.length, 'frames', fr.length,
  '| gap p10', p(0.1), 'p50', p(0.5), 'p90', p(0.9), 'ms',
  '| <=20ms', g.filter(x=>x<=20).length + '/' + g.length,
  '| lat p50', lat.length?lat[Math.floor(lat.length/2)].toFixed(0):'n/a');
"
}

mark
powershell -NoProfile -ExecutionPolicy Bypass -File "$REPO/tools/wheel-burst.ps1" 1 40 15 > /dev/null
powershell -NoProfile -ExecutionPolicy Bypass -File "$REPO/tools/wheel-burst.ps1" -1 40 15 > /dev/null
sleep 2
analyze "burst-continuous(40ms x30, down+up)"

sleep 3
mark
powershell -NoProfile -ExecutionPolicy Bypass -File "$REPO/tools/wheel-burst.ps1" 1 120 10 > /dev/null
sleep 2
analyze "burst-normal(120ms x10)"

grep -o 'frame_profile.\{0,300\}' "$REPO/.zig-cache/native-sdk-automation/snapshot.txt" | head -1
native automate profile off > /dev/null 2>&1

# Send real mouse-wheel notches at a fixed cadence (SendInput) for scroll measurement.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads .ps1 as cp932 without a BOM,
# and a Shift-JIS trail byte can swallow the following quote.
# usage: powershell -NoProfile -ExecutionPolicy Bypass -File wheel-burst.ps1 <notch> <gapMs> <count> [x] [y]
# notch 1 = 120 wheel counts downward; negative scrolls up.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class QbWheel {
  [StructLayout(LayoutKind.Sequential)] public struct M { public uint dx; public uint dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct I { [FieldOffset(0)] public uint type; [FieldOffset(8)] public M mi; }
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, I[] inputs, int cbSize);
  public static void At(int x, int y, int delta) {
    SetCursorPos(x, y);
    I[] a = new I[1]; a[0] = new I(); a[0].type = 0; a[0].mi.dwFlags = 0x0800; a[0].mi.mouseData = (uint)delta;
    SendInput(1, a, Marshal.SizeOf(typeof(I)));
  }
}
"@
$notch = [int]$args[0]
$gapMs = [int]$args[1]
$count = [int]$args[2]
$x = 190
$y = 320
if ($args.Length -gt 3) { $x = [int]$args[3] }
if ($args.Length -gt 4) { $y = [int]$args[4] }
$t0 = Get-Date
for ($i = 0; $i -lt $count; $i++) {
  [QbWheel]::At($x, $y, (-120 * $notch))
  Start-Sleep -Milliseconds $gapMs
}
Write-Output ("wheels=" + $count + " notch=" + $notch + " gap=" + $gapMs + "ms at=" + $x + "," + $y + " start=" + $t0.ToString("HH:mm:ss.fff"))

# QuotaBar — agent notes

## Windows + Bun dev setup

```sh
bun install -g @native-sdk/cli@0.9.3   # lands in ~/.bun/bin (add to PATH)
mise use -g zig@0.16.0                 # required; CLI can't fetch zig on Windows
SCRIPTC_CC=zigcc native dev            # zigcc avoids missing-clang error
SCRIPTC_CC=zigcc native build          # ReleaseFast → zig-out/bin/quotabar.exe
```

- `native dev` builds Debug — scrolling/layout is noticeably slower. Use `native build` + run the exe for real perf testing.
- `native check` is broken on Windows: it passes backslash paths to an import resolver that only understands `/`, so `components/...` imports fail. Use forward slashes: `native markup check src/windows/compact.native ...`. Build/dev are unaffected.

## Scroll / rendering on Windows

- All three windows are `transparent: false` (was `true`). Layered windows (`WS_EX_LAYERED`) cannot composite the child HWND's Direct2D packet surface → every frame fell back to CPU raster + full-window `UpdateLayeredWindow`, causing scroll lag. Opaque windows use the GPU packet path (~16ms frames, much lower memory).
- Wheel scrolling is patched in the installed SDK for browser-style smooth scroll (`tools/patch-native-sdk-scroll.sh`, re-apply after reinstalling the CLI): `wheel_multiplier=0.15` (6px instant), `wheel_velocity_scale=15`, `deceleration_per_second=2e-7` (~0.3s ease-out, ~45px/notch total), and velocity ACCUMULATES across rapid notches (`next.velocity += delta * scale` in `applyWheelWithRubberband`). SDK defaults were multiplier=1, velocity_scale=60, decel=0.86, velocity overwrite — that flung hundreds of px per notch.
- Windows has no native scroll driver in the SDK — scrolling is always the engine-side path.

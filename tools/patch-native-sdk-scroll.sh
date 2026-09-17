#!/bin/sh
# Browser-style smooth wheel scrolling for the installed Native SDK.
# Replaces the SDK default (instant 40px + runaway momentum, velocity
# overwritten per notch) with: 6px instant + ~39px eased over ~0.3s,
# velocity ACCUMULATING across fast wheel rolls.
# Re-run after any `bun install -g @native-sdk/cli` (the patch is in-place).
TOKENS="$USERPROFILE/.bun/install/global/node_modules/@native-sdk/cli/src/primitives/canvas/tokens.zig"
sed -i \
  -e 's/wheel_multiplier: f32 = [0-9.]*,/wheel_multiplier: f32 = 0.15,/' \
  -e 's/wheel_velocity_scale: f32 = [0-9.]*,/wheel_velocity_scale: f32 = 15,/' \
  -e 's/deceleration_per_second: f32 = [0-9.eE-]*,/deceleration_per_second: f32 = 0.0000002,/' \
  "$TOKENS"
sed -i 's/next\.velocity = scaled_delta \* physics\.wheel_velocity_scale;/next.velocity += delta * physics.wheel_velocity_scale;/' "$TOKENS"
grep -n "wheel_multiplier\|wheel_velocity_scale\|deceleration_per_second\|next.velocity" "$TOKENS" | head -8

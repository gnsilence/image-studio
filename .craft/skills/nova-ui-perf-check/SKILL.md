---
name: nova-ui-perf-check
description: Measure before/after scroll frame times and capture screenshots for nova-image-studio frontend styling changes with a dependency-free CDP harness on the cached headless Chromium. Use when a frontend restyle (globals.css, ui primitives, shell) must be shown not to regress performance.
version: 0.1.0
---

# Nova UI Performance Check

## Overview
Compare a baseline and a changed static export of `frontend/` side by side. Local static servers, Playwright's cached Chromium driven over raw CDP (no npm installs), seeded history data, screenshots, and scroll frame timings.

## When To Use
- Visual or CSS changes to nova-image-studio where the user requires no performance impact.
- Not for backend or API performance.

## Workflow
1. Baseline before editing: `cd frontend; $env:NOVA_DESKTOP_BUILD='1'; npm run build` (PWA off, so `public/sw.js` is not regenerated), then copy `frontend/out` to `%TEMP%\nova-ui-bench\baseline`. After changes, copy each build to a new folder (`after`, `after2`, ...); never overwrite a copy.
2. Harness (`%TEMP%\nova-ui-bench\bench.mjs`, Node 24 ESM; recreate if missing):
   - Static server per build on 127.0.0.1. `/api/*` returns 404 JSON and WebSocket upgrades are destroyed, which matches the app running without its backend.
   - Chromium: `%LOCALAPPDATA%\ms-playwright\chromium-1228\chrome-win64\chrome.exe --headless=new --remote-debugging-port=<p> --user-data-dir=<fresh> --ignore-gpu-blocklist --enable-gpu-rasterization --disable-gpu-vsync --disable-frame-rate-limit`. Headless still uses the real GPU; confirm with `SystemInfo.getInfo`.
   - CDP over Node's global `WebSocket`: `Target.createTarget`, then `Target.attachToTarget({ flatten: true })`.
   - Per page, `Page.addScriptToEvaluateOnNewDocument` sets localStorage `theme` and `nova-wide-mode` (`enabled`/`disabled`). For desktop styling it also defines a fake `window.novaDesktop` (config maps to localStorage, `records.list('image-records')` reads IndexedDB, other methods return empty results).
   - Seed once per origin: localStorage `nova-jobs` (jobs without image fields) plus IndexedDB `nova-image-db` version 2, store `images`, records `{ id, jobId, status, imageData, images, refImages, error }` with canvas-generated base64 PNGs. Use about 80 jobs over 10 days, because the history list is virtualized per day group.
   - Scroll `.studio-history-list` in requestAnimationFrame along a time-based cosine path (about 6 s) at device scale factor 1.5. Record frame deltas (avg, p95, p99, share above 17.5 ms) and `Performance.getMetrics` deltas (`TaskDuration`, `RecalcStyleDuration`, `LayoutDuration`). Count elements whose computed `backdrop-filter` is not `none`.
3. Run all targets in one browser session, interleaved per repetition (A,B then B,A), with 3 repetitions; compare medians. Run in the background and poll the log; a full run takes 6-8 minutes.
4. When a delta appears, build variants that each change one suspect and measure them together instead of reasoning about the cause.

## Common Pitfalls
- Wide mode renders hidden header duplicates of sidebar buttons (`随机图片`, `设置`): always click the first visible match.
- The settings dialog only scrolls at the Electron minimum height (1440x680).
- The history card delete button title is `移除` (its dialog title is `删除记录`). The single-image `添加到素材库` button fires an image-action toast; multi-image cards use a dropdown trigger (`aria-haspopup`).
- Run-to-run noise is about 2x (the same baseline measured 0.9 ms and 2.0 ms average). Only compare targets inside the same run.
- The minified React #418 hydration warning appears on every load, baseline included; use it as a control.
- `dark:` follows `html[data-theme]` and the OS preference. `[data-theme="dark"] *` selectors cost ancestor walks, so keep `dark:` classes off high-frequency primitives such as buttons and inputs.
- A fixed full-screen backdrop with `will-change` adds a full-screen compositor layer. Promote it only when the page scrolls (`html:not([data-wide-mode]) body::before`).
- Forced deletes are blocked in this environment; do not auto-delete profile folders from the script.
- Finish with a normal `npm run build` (without `NOVA_DESKTOP_BUILD`) so `frontend/out` registers the PWA again.

## Verification
- The final target's p95 and above-17 ms share are at or near the baseline medians; remaining deltas are explained against the 16.7 ms frame budget at 60 Hz.
- Screenshots reviewed for light/dark, web/desktop, normal/wide, plus dropdown, hover, settings, confirm dialog and toast.
- `npm run build` and `npm run test:run` pass; lint error and warning counts are unchanged versus baseline.

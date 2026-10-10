---
name: nova-image-delivery-diagnosis
description: Diagnose why an image task in nova-image-studio finishes long after the relay's log says generation completed, by separating generation time, relay-to-client transfer, and URL versus inline base64 delivery. Use when users report slow image results or "记录早就生成了但软件很久才出图".
version: 0.1.0
---

# Nova Image Delivery Diagnosis

## Overview
A task's total time = upstream generation + transfer of the result to this machine. The relay's usage log ("首字/耗时") only covers the relay fetching the image from its upstream, not delivering it to the client. Delivery depends on the upstream: an inline `b64_json` travels through the relay-to-client link; a `url` is downloaded by the backend from the upstream's CDN.

## When To Use
- The app shows "生成中" long after the relay log shows the request finished.
- One model or provider is fast and another is slow on the same relay.

## Workflow
1. Local timeline (free, read-only). Open `%LOCALAPPDATA%\Nova Image Studio\data\tasks.sqlite` with `mode=ro`:
   - `tasks`: created_at, completed_at, status, error, and request_json (model, baseUrl, outputSize, aspectRatio).
   - `task_items`: per-item status and timing.
   - Result files: `runtime\task-images\{taskId}-{item}-{sub}.*`. Check the real format from the magic bytes.
   - App side: `data\app.sqlite`, `app_settings` key `nova-jobs` and table `stored_files`. Never read `app_secrets`.
   - If backend completion and frontend storage fall in the same second, the delay is in the backend's upstream request, not in the UI.
2. Link probe (free). Fetch the relay's home page, then its js/css assets with `accept-encoding: identity`, and compute KB/s. As a control, download `https://registry.npmmirror.com/react-dom/-/react-dom-19.2.3.tgz`.
3. Instrumented request (costs one generation; ask the user first). Replicate the app's request:
   - `POST {base}/v1/images/generations` with `stream:true`, quality and background `auto`, `output_format` `png`, and no size when the setting is auto.
   - Timestamp the headers, the first body bytes and the end of the stream.
   - Parse the SSE like `backend/server.js`. Report inline `b64_json` versus `url`, and time the URL download.
   - Pass keys only through an environment variable and mask them in all output.

## Common Pitfalls
- `aioss.cc` and `www.aioss.cc` resolve to the same server, so switching between them does not change speed.
- Streaming is not the cause: stream and non-stream deliver the same bytes, and the stream contains a single `image_generation.completed` event.
- This relay ignores `output_format` and `output_compression`: a WebP q85 request still returned PNG.
- Base64 is about 1.33x the image size. A 4K PNG (about 13 MB) at about 33 KB/s takes 9 minutes or more.
- Model availability depends on the key's group. `404 ... not supported by any configured account in this group` comes back in about 1 s.
- The Exec tool times out on long waits. Run long probes in the background and poll for at most about 2 minutes per call.

## Verification
- total ≈ generation (time to headers) + transfer.
- The transfer rate matches the link probe taken at the same time. URL delivery is much faster whenever the CDN beats the relay link.

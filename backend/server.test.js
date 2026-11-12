const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function waitForMessage(child, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 15_000);
    const onMessage = message => {
      if (message?.type !== type) return;
      clearTimeout(timeout);
      child.off('message', onMessage);
      resolve(message);
    };
    child.on('message', onMessage);
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before ${type} with code ${code}`));
    });
  });
}

function waitForExit(child) {
  return new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

async function waitForTaskDone(baseUrl, taskId, headers) {
  let task;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const taskResponse = await fetch(`${baseUrl}/api/nova/tasks/${taskId}`, { headers });
    task = await taskResponse.json();
    if (task.status === 'completed' || task.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return task;
}

test('GPT Image 2.6 forwards model-specific parameters and preserves SVG/GIF results', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-image-26-test-'));
  const token = 'test-image-26-token';
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lW2mWQAAAABJRU5ErkJggg==';
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path d="M0 0h16v16H0z"/></svg>');
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const requests = [];
  let returnUrl = false;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const raw = Buffer.concat(chunks);
        const multipart = req.headers['content-type'].startsWith('multipart/');
        const body = multipart
          ? Object.fromEntries(await new Request('http://localhost', { method: 'POST', headers: req.headers, body: raw }).formData())
          : JSON.parse(raw);
        requests.push({ path: req.url, body });
        const format = body.output_format;
        const result = format === 'svg' ? svg : format === 'gif' ? gif : Buffer.from(pngBase64, 'base64');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [returnUrl ? { url: `https://images.example.com/result.${format}` } : { b64_json: result.toString('base64') }] }));
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
      }
    });
  });
  const address = await listen(upstream);
  const child = fork(path.join(__dirname, 'server.js'), [], {
    cwd: path.join(__dirname, '..'), silent: true,
    env: {
      ...process.env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: '0',
      NOVA_TASK_DB: path.join(tempDir, 'tasks.sqlite'), NOVA_IMAGE_DIR: path.join(tempDir, 'images'),
      NOVA_DESKTOP_SESSION_TOKEN: token, NOVA_IMAGE_STREAM: 'true', NOVA_IMAGE_PARTIAL_IMAGES: '2',
    },
  });
  try {
    const ready = await waitForMessage(child, 'ready');
    const headers = { 'Content-Type': 'application/json', 'X-Nova-Desktop-Token': token };
    const defaults = {
      apiKey: 'image-26-key', baseUrl: `http://127.0.0.1:${address.port}/v1/`, protocol: 'openai',
      mode: 'text-to-image', model: 'gpt-image-2.6-sunburst', prompt: 'test image',
      outputSize: '1K', aspectRatio: '1:1', temperature: 1, parallelCount: 1, images: [],
    };
    const submit = body => fetch(`${ready.url}/api/nova/tasks`, { method: 'POST', headers, body: JSON.stringify({ ...defaults, ...body }) });
    const complete = async body => {
      const response = await submit(body);
      assert.equal(response.status, 202, await response.clone().text());
      const { taskId } = await response.json();
      const task = await waitForTaskDone(ready.url, taskId, headers);
      assert.equal(task.status, 'completed', task.error);
      return { taskId, task };
    };
    await t.test('both 2.6 models accept extended quality and omit legacy fields', async () => {
      for (const [model, quality] of [['gpt-image-2.6-sunburst', 'max'], ['gpt-image-2.6-flare', 'xhigh']]) {
        await complete({ model, gptImageQuality: quality, gptImageStyle: 'vivid', gptImageComplexity: 'low', gptImageOutputFormat: 'webp' });
        const body = requests.at(-1).body;
        assert.equal(body.model, model);
        assert.equal(body.quality, quality);
        assert.equal(body.complexity, 'low');
        assert.equal(body.output_format, 'webp');
        assert.equal(body.stream, true);
        for (const field of ['response_format', 'style', 'input_fidelity', 'frame_count', 'frame_duration_ms']) assert.equal(body[field], undefined);
      }
    });
    await t.test('defaults use high complexity and PNG', async () => {
      await complete({});
      assert.equal(requests.at(-1).body.complexity, 'high');
      assert.equal(requests.at(-1).body.output_format, 'png');
    });
    await t.test('SVG and GIF use one output without streaming and retain MIME on disk', async () => {
      for (const [format, bytes, mime] of [['svg', svg, 'image/svg+xml'], ['gif', gif, 'image/gif']]) {
        const { taskId, task } = await complete({ gptImageOutputFormat: format, gptImageFrameCount: 16, gptImageFrameDurationMs: 250 });
        const body = requests.at(-1).body;
        assert.equal(body.n, 1);
        for (const field of ['stream', 'partial_images', 'output_compression', 'prompt_rewriter']) assert.equal(body[field], undefined);
        if (format === 'gif') {
          assert.equal(body.size, 'auto');
          assert.equal(body.frame_count, 16);
          assert.equal(body.frame_duration_ms, 250);
        }
        const stored = await fetch(`${ready.url}${task.result.images[0].substring(4)}`, { headers });
        assert.equal(stored.headers.get('content-type'), mime);
        assert.equal(stored.headers.get('x-content-type-options'), 'nosniff');
        if (format === 'svg') assert.match(stored.headers.get('content-security-policy'), /sandbox/);
        assert.deepEqual(Buffer.from(await stored.arrayBuffer()), bytes);
        assert.ok(fs.existsSync(path.join(tempDir, 'images', `${taskId}-0-0.${format}`)));
      }
    });
    await t.test('URL results preserve their SVG/GIF addresses', async () => {
      returnUrl = true;
      for (const format of ['svg', 'gif']) {
        const { task } = await complete({ gptImageOutputFormat: format });
        assert.deepEqual(task.result.images, [`URL:https://images.example.com/result.${format}`]);
      }
      returnUrl = false;
    });
    await t.test('GIF edits forward still references and animation settings for both 2.6 models', async () => {
      for (const [model, settings, frameCount, frameDurationMs] of [
        ['gpt-image-2.6-flare', { gptImageFrameCount: 12, gptImageFrameDurationMs: 350 }, '12', '350'],
        ['gpt-image-2.6-sunburst', {}, '9', '200'],
      ]) {
        const { taskId, task } = await complete({
          mode: 'image-to-image', model,
          images: [{ data: pngBase64, mimeType: 'image/png' }],
          gptImageOutputFormat: 'gif', outputSize: '4K', customSize: '3840x2160',
          gptImageComplexity: 'low', gptImageQuality: 'high', ...settings,
        });
        const { path: endpoint, body } = requests.at(-1);
        assert.equal(endpoint, '/v1/images/edits');
        assert.equal(body.model, model);
        assert.equal(body.output_format, 'gif');
        assert.equal(body.size, 'auto');
        assert.equal(body.n, '1');
        assert.equal(body.frame_count, frameCount);
        assert.equal(body.frame_duration_ms, frameDurationMs);
        assert.equal(body.complexity, 'low');
        assert.equal(body.quality, 'high');
        assert.equal(body.image.type, 'image/png');
        assert.deepEqual(Buffer.from(await body.image.arrayBuffer()), Buffer.from(pngBase64, 'base64'));
        for (const field of ['stream', 'partial_images', 'output_compression', 'prompt_rewriter', 'response_format']) assert.equal(body[field], undefined);
        const stored = await fetch(`${ready.url}${task.result.images[0].substring(4)}`, { headers });
        assert.equal(stored.headers.get('content-type'), 'image/gif');
        assert.deepEqual(Buffer.from(await stored.arrayBuffer()), gif);
        assert.ok(fs.existsSync(path.join(tempDir, 'images', `${taskId}-0-0.gif`)));
      }
    });
    await t.test('parallel SVG results remain separate requests with one output each', async () => {
      const before = requests.length;
      const { task } = await complete({ gptImageOutputFormat: 'svg', parallelCount: 2 });
      assert.equal(requests.length, before + 2);
      assert.equal(task.result.images.length, 2);
      for (const request of requests.slice(before)) assert.equal(request.body.n, 1);
    });
    await t.test('markup is sent as a separate PNG file and only metadata is persisted', async () => {
      const { taskId } = await complete({
        mode: 'image-to-image', images: [{ data: pngBase64, mimeType: 'image/png' }],
        gptImageMarkup: { data: pngBase64, mimeType: 'image/png' }, gptImageOutputFormat: 'jpeg',
        gptImageComplexity: 'medium', gptImageQuality: 'xhigh',
      });
      const { path: endpoint, body } = requests.at(-1);
      assert.equal(endpoint, '/v1/images/edits');
      assert.equal(body.complexity, 'medium');
      assert.equal(body.output_format, 'jpeg');
      assert.equal(body.quality, 'xhigh');
      assert.equal(body.markup.type, 'image/png');
      assert.deepEqual(Buffer.from(await body.markup.arrayBuffer()), Buffer.from(pngBase64, 'base64'));
      for (const field of ['response_format', 'style', 'input_fidelity', 'mask', 'frame_count', 'frame_duration_ms']) assert.equal(body[field], undefined);
      const Database = require('better-sqlite3');
      const db = new Database(path.join(tempDir, 'tasks.sqlite'), { readonly: true });
      try {
        const request = JSON.parse(db.prepare('SELECT request_json FROM tasks WHERE id = ?').get(taskId).request_json);
        assert.deepEqual(request.gptImageMarkup, { mimeType: 'image/png', width: 1, height: 1 });
        assert.equal(request.gptImageComplexity, 'medium');
        assert.equal(request.gptImageOutputFormat, 'jpeg');
        assert.ok(!JSON.stringify(request).includes(pngBase64));
      } finally { db.close(); }
    });
    await t.test('invalid 2.6 combinations are rejected before reaching upstream', async () => {
      const before = requests.length;
      const mismatched = Buffer.from(pngBase64, 'base64');
      mismatched.writeUInt32BE(2, 16);
      const oversized = Buffer.from(pngBase64, 'base64');
      oversized.writeUInt32BE(4097, 16);
      oversized.writeUInt32BE(4096, 20);
      const opaque = Buffer.from(pngBase64, 'base64');
      opaque[25] = 2;
      const invalid = [
        { gptImageComplexity: 'extreme' }, { gptImageOutputFormat: 'bmp' },
        { gptImageFrameCount: 1 }, { gptImageFrameCount: 17 }, { gptImageFrameCount: 3.5 },
        { gptImageFrameDurationMs: 19 }, { gptImageFrameDurationMs: 2001 },
        { mode: 'image-to-image', images: [{ data: pngBase64, mimeType: 'image/png' }], gptImageOutputFormat: 'svg' },
        { gptImageOutputFormat: 'jpeg', gptImageBackground: 'transparent' },
        { gptImageMarkup: { data: pngBase64, mimeType: 'image/png' } },
        { mode: 'image-to-image', images: [] },
        { mode: 'image-to-image', images: [{ data: gif.toString('base64'), mimeType: 'image/gif' }] },
        { mode: 'image-to-image', images: [{ data: pngBase64, mimeType: 'image/png' }], gptImageMarkup: { data: pngBase64, mimeType: 'image/png' }, mask: 'test' },
        ...[
          { data: gif.toString('base64'), mimeType: 'image/png' },
          { data: pngBase64, mimeType: 'image/jpeg' },
          { data: mismatched.toString('base64'), mimeType: 'image/png' },
          { data: oversized.toString('base64'), mimeType: 'image/png' },
          { data: opaque.toString('base64'), mimeType: 'image/png' },
        ].map(gptImageMarkup => ({ mode: 'image-to-image', images: [{ data: pngBase64, mimeType: 'image/png' }], gptImageMarkup })),
      ];
      for (const body of invalid) {
        const response = await submit(body);
        assert.equal(response.status, 400, JSON.stringify(body));
      }
      assert.equal(requests.length, before);
    });
    await t.test('2.5 extended quality works while other models keep legacy fields', async () => {
      await complete({ model: 'gpt-image-2.5-flare', gptImageQuality: 'max', gptImageStyle: 'natural', gptImageOutputFormat: 'svg', gptImageComplexity: 'low' });
      const body = requests.at(-1).body;
      assert.equal(body.quality, 'max');
      assert.equal(body.response_format, 'url');
      assert.equal(body.style, 'natural');
      assert.equal(body.output_format, 'png');
      assert.equal(body.complexity, undefined);
    });
  } finally {
    if (child.connected) {
      const exited = waitForExit(child);
      child.send({ type: 'stop' });
      await exited;
    } else if (!child.killed) child.kill('SIGKILL');
    child.stdout?.destroy(); child.stderr?.destroy();
    await closeServer(upstream);
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows file handles may close shortly after child exit. */ }
  }
});

test('Grok Imagine 2.0 forwards official parameters and returns every batch result in one request', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-image-grok2-test-'));
  const token = 'test-grok2-session-token';
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lW2mWQAAAABJRU5ErkJggg==';
  const requests = [];
  let base64Response = false;
  let rejectRequest = false;
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push({ path: req.url, body });
      res.writeHead(rejectRequest ? 400 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rejectRequest
        ? { error: { message: 'quality unsupported by test upstream' } }
        : { data: Array.from({ length: body.n }, (_, index) => (
          base64Response ? { b64_json: pngBase64 } : { url: `https://images.example.com/grok2-${index}.png` }
        )) }));
    });
  });
  const upstreamAddress = await listen(upstream);
  const child = fork(path.join(__dirname, 'server.js'), [], {
    cwd: path.join(__dirname, '..'),
    silent: true,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOSTNAME: '127.0.0.1',
      PORT: '0',
      NOVA_TASK_DB: path.join(tempDir, 'tasks.sqlite'),
      NOVA_IMAGE_DIR: path.join(tempDir, 'images'),
      NOVA_DESKTOP_SESSION_TOKEN: token,
    },
  });

  try {
    const ready = await waitForMessage(child, 'ready');
    const headers = { 'Content-Type': 'application/json', 'X-Nova-Desktop-Token': token };
    const defaults = {
      apiKey: 'test-grok2-key',
      baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1/`,
      protocol: 'grok',
      mode: 'text-to-image',
      prompt: 'test image',
      outputSize: '1K',
      aspectRatio: 'auto',
      temperature: 1,
      model: 'grok-imagine-image-2.0',
      gptImageQuality: 'auto',
      parallelCount: 1,
      images: [],
    };
    const submit = body => fetch(`${ready.url}/api/nova/tasks`, {
      method: 'POST', headers, body: JSON.stringify({ ...defaults, ...body }),
    });
    const cases = [
      { name: 'text generation at 1.5K', count: 1, refs: 0, size: '1.5K', quality: 'low', ratio: '5:2', base64: true },
      { name: 'single reference edit', count: 1, refs: 1, size: '2K', quality: 'medium', ratio: '9:19.5', base64: true },
      { name: 'five references and ten outputs', count: 10, refs: 5, size: '2K', quality: 'auto', ratio: 'auto', base64: true },
      { name: 'all Base64 batch outputs are stored', count: 3, refs: 0, size: '1K', quality: 'medium', ratio: '21:9', base64: true },
      { name: 'reference edit returns URLs when enabled', count: 1, refs: 1, size: '1K', quality: 'medium', ratio: '1:1', base64: false, useUrl: true },
    ];
    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        base64Response = Boolean(scenario.base64);
        const before = requests.length;
        const response = await submit({
          mode: scenario.refs ? 'image-to-image' : 'text-to-image',
          images: Array.from({ length: scenario.refs }, () => ({ mimeType: 'image/png', data: pngBase64 })),
          outputSize: scenario.size,
          aspectRatio: scenario.ratio,
          gptImageQuality: scenario.quality,
          gptImageStyle: 'vivid',
          gptImageBackground: 'transparent',
          parallelCount: scenario.count,
          ...(scenario.useUrl ? { grokImageUseUrl: true } : {}),
        });
        assert.equal(response.status, 202);
        const { taskId } = await response.json();
        const task = await waitForTaskDone(ready.url, taskId, headers);
        assert.equal(task.status, 'completed', task.error);
        assert.equal(requests.length, before + 1);
        const forwarded = requests[before];
        assert.equal(forwarded.path, scenario.refs ? '/v1/images/edits' : '/v1/images/generations');
        assert.deepEqual(forwarded.body, {
          model: 'grok-imagine-image-2.0',
          prompt: defaults.prompt,
          n: scenario.count,
          response_format: scenario.useUrl ? 'url' : 'b64_json',
          resolution: scenario.size.toLowerCase(),
          aspect_ratio: scenario.ratio,
          quality: scenario.quality,
          ...(scenario.refs === 1 ? { image: { type: 'image_url', url: `data:image/png;base64,${pngBase64}` } } : {}),
          ...(scenario.refs > 1 ? { images: Array.from({ length: scenario.refs }, () => ({
            type: 'image_url', url: `data:image/png;base64,${pngBase64}`,
          })) } : {}),
        });
        assert.equal(task.result.images.length, scenario.count);
        if (scenario.base64) {
          for (const image of task.result.images) {
            assert.ok(image.startsWith('URL:/api/nova/images/'));
            const stored = await fetch(`${ready.url}${image.substring(4)}`, { headers });
            assert.equal(stored.status, 200);
            assert.deepEqual(Buffer.from(await stored.arrayBuffer()), Buffer.from(pngBase64, 'base64'));
          }
        } else {
          assert.deepEqual(task.result.images, Array.from({ length: scenario.count }, (_, index) => `URL:https://images.example.com/grok2-${index}.png`));
        }
      });
    }

    await t.test('unsupported parameters are rejected before contacting the upstream', async () => {
      const before = requests.length;
      const invalidCases = [
        { parallelCount: 11 },
        { parallelCount: 5, model: 'grok-imagine-image-quality' },
        { gptImageQuality: 'high' },
        { grokImageUseUrl: 'true' },
        { outputSize: '4K' },
        { aspectRatio: '4:5' },
        { mode: 'image-to-image', images: [] },
        { mode: 'image-to-image', images: Array.from({ length: 6 }, () => ({ mimeType: 'image/png', data: pngBase64 })) },
      ];
      for (const invalid of invalidCases) {
        const response = await submit(invalid);
        assert.equal(response.status, 400, JSON.stringify(invalid));
      }
      assert.equal(requests.length, before);
    });

    await t.test('upstream errors do not trigger another generation request', async () => {
      rejectRequest = true;
      const before = requests.length;
      const response = await submit({});
      assert.equal(response.status, 202);
      const { taskId } = await response.json();
      const task = await waitForTaskDone(ready.url, taskId, headers);
      assert.equal(task.status, 'failed');
      assert.match(task.error, /quality unsupported by test upstream/);
      assert.equal(requests.length, before + 1);
    });
  } finally {
    if (child.connected) {
      const exitPromise = waitForExit(child);
      child.send({ type: 'stop' });
      await exitPromise;
    } else if (!child.killed) {
      child.kill('SIGKILL');
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    await closeServer(upstream);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may retain the SQLite file handle briefly after child exit.
    }
  }
});

test('desktop server uses an ephemeral port, enforces its token, and stops cleanly', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-backend-test-'));
  const token = 'test-desktop-session-token';
  const child = fork(path.join(__dirname, 'server.js'), [], {
    cwd: path.join(__dirname, '..'),
    silent: true,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOSTNAME: '127.0.0.1',
      PORT: '0',
      NOVA_TASK_DB: path.join(tempDir, 'tasks.sqlite'),
      NOVA_IMAGE_DIR: path.join(tempDir, 'images'),
      NOVA_DESKTOP_SESSION_TOKEN: token,
    },
  });

  try {
    const ready = await waitForMessage(child, 'ready');
    assert.equal(ready.host, '127.0.0.1');
    assert.ok(Number.isInteger(ready.port) && ready.port > 0);

    const home = await fetch(`${ready.url}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /AIOSS Image/i);

    const unauthorized = await fetch(`${ready.url}/api/nova/queue-status`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${ready.url}/api/nova/queue-status`, {
      headers: { 'X-Nova-Desktop-Token': token },
    });
    assert.equal(authorized.status, 200);
    const queueStatus = await authorized.json();
    assert.equal(typeof queueStatus.processingCount, 'number');
    assert.equal(typeof queueStatus.queuedCount, 'number');

    const exitPromise = waitForExit(child);
    child.send({ type: 'stop' });
    const exit = await exitPromise;
    assert.equal(exit.code, 0);
    await assert.rejects(fetch(`${ready.url}/api/nova/queue-status`));
  } finally {
    if (child.connected) child.kill('SIGKILL');
    child.stdout?.destroy();
    child.stderr?.destroy();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may retain the SQLite file handle briefly after child exit.
    }
  }
});

test('image tasks call the configured Base URL', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-image-base-url-test-'));
  const token = 'test-custom-image-base-url-token';
  const upstreamRequests = [];
  const upstreamBodies = [];
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lW2mWQAAAABJRU5ErkJggg==';
  const upstream = http.createServer((req, res) => {
    upstreamRequests.push({ url: req.url, authorization: req.headers.authorization });
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      upstreamBodies.push(raw ? JSON.parse(raw) : {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: pngBase64 }] }));
    });
  });
  const upstreamAddress = await listen(upstream);
  const childEnv = {
    ...process.env,
    NODE_ENV: 'production',
    HOSTNAME: '127.0.0.1',
    PORT: '0',
    NOVA_TASK_DB: path.join(tempDir, 'tasks.sqlite'),
    NOVA_IMAGE_DIR: path.join(tempDir, 'images'),
    NOVA_DESKTOP_SESSION_TOKEN: token,
  };
  delete childEnv.NOVA_IMAGE_STREAM;
  const child = fork(path.join(__dirname, 'server.js'), [], {
    cwd: path.join(__dirname, '..'),
    silent: true,
    env: childEnv,
  });

  try {
    const ready = await waitForMessage(child, 'ready');
    const headers = {
      'Content-Type': 'application/json',
      'X-Nova-Desktop-Token': token,
    };
    const response = await fetch(`${ready.url}/api/nova/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        apiKey: 'custom-image-key',
        baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1/`,
        protocol: 'openai',
        mode: 'text-to-image',
        prompt: 'test image',
        outputSize: '1K',
        aspectRatio: '2:3',
        temperature: 1,
        model: 'gpt-image-2',
        parallelCount: 1,
        images: [],
      }),
    });
    assert.equal(response.status, 202);
    const { taskId } = await response.json();

    const task = await waitForTaskDone(ready.url, taskId, headers);

    assert.equal(task?.status, 'completed', task?.error);
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0].url, '/v1/images/generations');
    assert.equal(upstreamRequests[0].authorization, 'Bearer custom-image-key');
    assert.equal(upstreamBodies.length, 1);
    assert.equal(upstreamBodies[0].size, '1024x1536');
    assert.equal(upstreamBodies[0].stream, undefined);
    assert.equal(upstreamBodies[0].response_format, 'url');
  } finally {
    if (child.connected) {
      const exitPromise = waitForExit(child);
      child.send({ type: 'stop' });
      await exitPromise;
    } else if (!child.killed) {
      child.kill('SIGKILL');
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    await closeServer(upstream);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may retain the SQLite file handle briefly after child exit.
    }
  }
});

test('OpenAI image tasks retry without streaming when the upstream rejects stream params', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-image-stream-fallback-test-'));
  const token = 'test-image-stream-fallback-token';
  const upstreamBodies = [];
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lW2mWQAAAABJRU5ErkJggg==';
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      upstreamBodies.push(body);
      if (body.stream) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'stream is unsupported for this model' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: pngBase64 }] }));
    });
  });
  const upstreamAddress = await listen(upstream);
  const child = fork(path.join(__dirname, 'server.js'), [], {
    cwd: path.join(__dirname, '..'),
    silent: true,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOSTNAME: '127.0.0.1',
      PORT: '0',
      NOVA_TASK_DB: path.join(tempDir, 'tasks.sqlite'),
      NOVA_IMAGE_DIR: path.join(tempDir, 'images'),
      NOVA_DESKTOP_SESSION_TOKEN: token,
      NOVA_IMAGE_STREAM: 'true',
      NOVA_IMAGE_PARTIAL_IMAGES: '2',
    },
  });

  try {
    const ready = await waitForMessage(child, 'ready');
    const headers = {
      'Content-Type': 'application/json',
      'X-Nova-Desktop-Token': token,
    };
    const response = await fetch(`${ready.url}/api/nova/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        apiKey: 'custom-image-key',
        baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1/`,
        protocol: 'openai',
        mode: 'text-to-image',
        prompt: 'test image',
        outputSize: '1K',
        aspectRatio: '1:1',
        temperature: 1,
        model: 'gpt-image-2',
        parallelCount: 1,
        images: [],
      }),
    });
    assert.equal(response.status, 202);
    const { taskId } = await response.json();

    const task = await waitForTaskDone(ready.url, taskId, headers);

    assert.equal(task?.status, 'completed', task?.error);
    assert.equal(upstreamBodies.length, 2);
    assert.equal(upstreamBodies[0].stream, true);
    assert.equal(upstreamBodies[0].partial_images, 2);
    assert.equal(upstreamBodies[1].stream, undefined);
    assert.equal(upstreamBodies[1].partial_images, undefined);
  } finally {
    if (child.connected) {
      const exitPromise = waitForExit(child);
      child.send({ type: 'stop' });
      await exitPromise;
    } else if (!child.killed) {
      child.kill('SIGKILL');
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    await closeServer(upstream);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may retain the SQLite file handle briefly after child exit.
    }
  }
});

test('NOVA_TASK_TTL_HOURS controls completed task expiration', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-task-ttl-test-'));
  const token = 'test-task-ttl-token';
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lW2mWQAAAABJRU5ErkJggg==';
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: pngBase64 }] }));
  });
  const upstreamAddress = await listen(upstream);
  const child = fork(path.join(__dirname, 'server.js'), [], {
    cwd: path.join(__dirname, '..'),
    silent: true,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOSTNAME: '127.0.0.1',
      PORT: '0',
      NOVA_TASK_DB: path.join(tempDir, 'tasks.sqlite'),
      NOVA_IMAGE_DIR: path.join(tempDir, 'images'),
      NOVA_DESKTOP_SESSION_TOKEN: token,
      NOVA_TASK_TTL_HOURS: '1',
      NOVA_IMAGE_STREAM: 'false',
    },
  });

  try {
    const ready = await waitForMessage(child, 'ready');
    const headers = {
      'Content-Type': 'application/json',
      'X-Nova-Desktop-Token': token,
    };
    const response = await fetch(`${ready.url}/api/nova/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        apiKey: 'custom-image-key',
        baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1/`,
        protocol: 'openai',
        mode: 'text-to-image',
        prompt: 'test image',
        outputSize: '1K',
        aspectRatio: '1:1',
        temperature: 1,
        model: 'gpt-image-2',
        parallelCount: 1,
        images: [],
      }),
    });
    assert.equal(response.status, 202);
    const { taskId } = await response.json();

    const task = await waitForTaskDone(ready.url, taskId, headers);

    assert.equal(task?.status, 'completed', task?.error);
    const createdAt = Date.parse(task.createdAt);
    const expiresAt = Date.parse(task.expiresAt);
    assert.ok(Number.isFinite(createdAt));
    assert.ok(Number.isFinite(expiresAt));
    assert.ok(Math.abs((expiresAt - createdAt) - 60 * 60 * 1000) < 30_000);
  } finally {
    if (child.connected) {
      const exitPromise = waitForExit(child);
      child.send({ type: 'stop' });
      await exitPromise;
    } else if (!child.killed) {
      child.kill('SIGKILL');
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    await closeServer(upstream);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may retain the SQLite file handle briefly after child exit.
    }
  }
});

test('Grok image tasks complete from inline base64 without downloading remote URLs', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-image-grok-b64-test-'));
  const token = 'test-image-grok-b64-token';
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lW2mWQAAAABJRU5ErkJggg==';
  let upstreamBody = null;
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      upstreamBody = raw ? JSON.parse(raw) : {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: pngBase64 }] }));
    });
  });
  const upstreamAddress = await listen(upstream);
  const child = fork(path.join(__dirname, 'server.js'), [], {
    cwd: path.join(__dirname, '..'),
    silent: true,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOSTNAME: '127.0.0.1',
      PORT: '0',
      NOVA_TASK_DB: path.join(tempDir, 'tasks.sqlite'),
      NOVA_IMAGE_DIR: path.join(tempDir, 'images'),
      NOVA_DESKTOP_SESSION_TOKEN: token,
    },
  });

  try {
    const ready = await waitForMessage(child, 'ready');
    const headers = {
      'Content-Type': 'application/json',
      'X-Nova-Desktop-Token': token,
    };
    const response = await fetch(`${ready.url}/api/nova/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        apiKey: 'custom-image-key',
        baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1/`,
        protocol: 'grok',
        mode: 'text-to-image',
        prompt: 'test image',
        outputSize: '1K',
        aspectRatio: '1:1',
        temperature: 1,
        model: 'grok-imagine-image-quality',
        parallelCount: 1,
        images: [],
      }),
    });
    assert.equal(response.status, 202);
    const { taskId } = await response.json();

    const task = await waitForTaskDone(ready.url, taskId, headers);

    assert.equal(task?.status, 'completed', task?.error);
    assert.deepEqual(task.result?.images?.length, 1);
    assert.equal(task.result?.images?.[0]?.startsWith('URL:/api/nova/images/'), true);
    assert.equal(upstreamBody?.response_format, 'b64_json');
  } finally {
    if (child.connected) {
      const exitPromise = waitForExit(child);
      child.send({ type: 'stop' });
      await exitPromise;
    } else if (!child.killed) {
      child.kill('SIGKILL');
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    await closeServer(upstream);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may retain the SQLite file handle briefly after child exit.
    }
  }
});

test('URL image tasks preserve the remote URL when it is unreachable', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-image-url-download-fallback-test-'));
  const token = 'test-image-url-download-fallback-token';
  const unreachableImageUrl = 'http://127.0.0.1:9/generated.png';
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ url: unreachableImageUrl }] }));
  });
  const upstreamAddress = await listen(upstream);
  const child = fork(path.join(__dirname, 'server.js'), [], {
    cwd: path.join(__dirname, '..'),
    silent: true,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOSTNAME: '127.0.0.1',
      PORT: '0',
      NOVA_TASK_DB: path.join(tempDir, 'tasks.sqlite'),
      NOVA_IMAGE_DIR: path.join(tempDir, 'images'),
      NOVA_DESKTOP_SESSION_TOKEN: token,
      NOVA_IMAGE_STREAM: 'false',
    },
  });

  try {
    const ready = await waitForMessage(child, 'ready');
    const headers = {
      'Content-Type': 'application/json',
      'X-Nova-Desktop-Token': token,
    };
    const response = await fetch(`${ready.url}/api/nova/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        apiKey: 'custom-image-key',
        baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1/`,
        protocol: 'grok',
        mode: 'text-to-image',
        prompt: 'test image',
        outputSize: '1K',
        aspectRatio: '1:1',
        temperature: 1,
        model: 'grok-imagine-image-quality',
        parallelCount: 1,
        images: [],
      }),
    });
    assert.equal(response.status, 202);
    const { taskId } = await response.json();

    const task = await waitForTaskDone(ready.url, taskId, headers);

    assert.equal(task?.status, 'completed', task?.error);
    assert.deepEqual(task.result?.images, [`URL:${unreachableImageUrl}`]);
  } finally {
    if (child.connected) {
      const exitPromise = waitForExit(child);
      child.send({ type: 'stop' });
      await exitPromise;
    } else if (!child.killed) {
      child.kill('SIGKILL');
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    await closeServer(upstream);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may retain the SQLite file handle briefly after child exit.
    }
  }
});

test('Grok URL image tasks preserve remote URL results without server-side download', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-image-grok-no-proxy-test-'));
  const token = 'test-image-grok-no-proxy-token';
  const pngBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lW2mWQAAAABJRU5ErkJggg==', 'base64');
  let imageDownloads = 0;
  const upstreamResponseFormats = [];
  const imageServer = http.createServer((req, res) => {
    imageDownloads += 1;
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': pngBuffer.length });
    res.end(pngBuffer);
  });
  const imageAddress = await listen(imageServer);
  const originalImageUrl = `http://127.0.0.1:${imageAddress.port}/original.png`;
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      upstreamResponseFormats.push(body.response_format);
      if (body.response_format === 'b64_json') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'response_format b64_json unsupported' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ url: originalImageUrl }] }));
    });
  });
  const upstreamAddress = await listen(upstream);
  const child = fork(path.join(__dirname, 'server.js'), [], {
    cwd: path.join(__dirname, '..'),
    silent: true,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOSTNAME: '127.0.0.1',
      PORT: '0',
      NOVA_TASK_DB: path.join(tempDir, 'tasks.sqlite'),
      NOVA_IMAGE_DIR: path.join(tempDir, 'images'),
      NOVA_DESKTOP_SESSION_TOKEN: token,
      NOVA_IMAGE_STREAM: 'false',
    },
  });

  try {
    const ready = await waitForMessage(child, 'ready');
    const headers = {
      'Content-Type': 'application/json',
      'X-Nova-Desktop-Token': token,
    };
    const response = await fetch(`${ready.url}/api/nova/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        apiKey: 'custom-image-key',
        baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1/`,
        protocol: 'grok',
        mode: 'text-to-image',
        prompt: 'test image',
        outputSize: '1K',
        aspectRatio: '1:1',
        temperature: 1,
        model: 'grok-imagine-image-quality',
        parallelCount: 1,
        images: [],
      }),
    });
    assert.equal(response.status, 202);
    const { taskId } = await response.json();

    const task = await waitForTaskDone(ready.url, taskId, headers);

    assert.equal(task?.status, 'completed', task?.error);
    assert.deepEqual(task.result?.images, [`URL:${originalImageUrl}`]);
    assert.equal(imageDownloads, 0);
    assert.deepEqual(upstreamResponseFormats, ['b64_json', 'url']);
  } finally {
    if (child.connected) {
      const exitPromise = waitForExit(child);
      child.send({ type: 'stop' });
      await exitPromise;
    } else if (!child.killed) {
      child.kill('SIGKILL');
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    await closeServer(upstream);
    await closeServer(imageServer);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may retain the SQLite file handle briefly after child exit.
    }
  }
});

test('GPT Image 2.6 WebP edits normalize upstream PNG results without another generation', async t => {
  const sharp = require('sharp');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-image-26-webp-test-'));
  const token = 'test-image-26-webp-token';
  const pixels = Buffer.from([255, 0, 0, 255, 13, 27, 42, 0, 0, 127, 255, 128, 23, 42, 255, 255]);
  const png = await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer();
  const webp = await sharp(png).webp({ lossless: true, exact: true }).toBuffer();
  const generationRequests = [];
  const imageRequests = [];
  let scenario;
  let upstreamUrl;
  const upstream = http.createServer((req, res) => {
    if (req.method === 'GET') {
      imageRequests.push({ path: req.url, authorization: req.headers.authorization });
      if (req.url === '/result/missing.png') {
        res.writeHead(503);
        res.end('image unavailable');
        return;
      }
      const result = req.url.endsWith('.webp') ? webp : png;
      res.writeHead(200, { 'Content-Type': req.url.endsWith('.webp') ? 'image/webp' : 'image/png' });
      res.end(result);
      return;
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const raw = Buffer.concat(chunks);
        const body = req.headers['content-type'].startsWith('multipart/')
          ? Object.fromEntries(await new Request('http://localhost', { method: 'POST', headers: req.headers, body: raw }).formData())
          : JSON.parse(raw);
        generationRequests.push({ path: req.url, body });
        const result = scenario.format === 'webp' ? webp : scenario.format === 'invalid' ? Buffer.from('not an image') : png;
        if (scenario.wire === 'sse') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(`data: ${JSON.stringify({ type: 'image_edit.partial_image', b64_json: png.toString('base64') })}\n\n`
            + `data: ${JSON.stringify({ type: 'image_edit.completed', b64_json: result.toString('base64'), output_format: scenario.format })}\n\n`
            + 'data: [DONE]\n\n');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ output_format: scenario.format, data: [scenario.wire === 'url'
          ? { url: `${upstreamUrl}/result/${scenario.missing ? 'missing.png' : `image.${scenario.format}`}` }
          : { b64_json: result.toString('base64') }] }));
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
      }
    });
  });
  const address = await listen(upstream);
  upstreamUrl = `http://127.0.0.1:${address.port}`;
  const child = fork(path.join(__dirname, 'server.js'), [], {
    cwd: path.join(__dirname, '..'), silent: true,
    env: {
      ...process.env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: '0',
      NOVA_TASK_DB: path.join(tempDir, 'tasks.sqlite'), NOVA_IMAGE_DIR: path.join(tempDir, 'images'),
      NOVA_DESKTOP_SESSION_TOKEN: token, NOVA_IMAGE_STREAM: 'true', NOVA_IMAGE_PARTIAL_IMAGES: '2',
    },
  });
  try {
    const ready = await waitForMessage(child, 'ready');
    const headers = { 'Content-Type': 'application/json', 'X-Nova-Desktop-Token': token };
    const complete = async (overrides = {}, response = { wire: 'json', format: 'png' }) => {
      scenario = response;
      const generationCount = generationRequests.length;
      const imageCount = imageRequests.length;
      const submitted = await fetch(`${ready.url}/api/nova/tasks`, {
        method: 'POST', headers,
        body: JSON.stringify({
          apiKey: 'image-26-webp-key', baseUrl: upstreamUrl, protocol: 'openai',
          mode: 'image-to-image', model: 'gpt-image-2.6-sunburst', prompt: 'local WebP test',
          outputSize: '1K', aspectRatio: '1:1', temperature: 1, parallelCount: 1,
          images: [{ data: png.toString('base64'), mimeType: 'image/png' }], gptImageOutputFormat: 'webp',
          ...overrides,
        }),
      });
      assert.equal(submitted.status, 202, await submitted.clone().text());
      const { taskId } = await submitted.json();
      const task = await waitForTaskDone(ready.url, taskId, headers);
      assert.equal(generationRequests.length, generationCount + 1, 'normalizing an existing result must not generate another image');
      return { taskId, task, request: generationRequests.at(-1), downloads: imageRequests.slice(imageCount) };
    };
    const storedResult = async ({ taskId, task }, extension, mime) => {
      assert.equal(task.status, 'completed', task.error);
      assert.ok(task.result.images[0].startsWith('URL:/api/nova/images/'));
      const stored = await fetch(`${ready.url}${task.result.images[0].substring(4)}`, { headers });
      assert.equal(stored.headers.get('content-type'), mime);
      const bytes = Buffer.from(await stored.arrayBuffer());
      assert.deepEqual(bytes, fs.readFileSync(path.join(tempDir, 'images', `${taskId}-0-0.${extension}`)));
      return bytes;
    };
    for (const model of ['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare']) {
      for (const wire of ['json', 'sse', 'url']) {
        await t.test(`${model} preserves RGBA pixels when ${wire} edits return PNG for WebP`, async () => {
          const result = await complete({ model }, { wire, format: 'png' });
          assert.equal(result.request.path, '/v1/images/edits');
          assert.equal(result.request.body.output_format, 'webp');
          assert.equal(result.downloads.length, wire === 'url' ? 1 : 0);
          for (const download of result.downloads) assert.equal(download.authorization, undefined);
          const bytes = await storedResult(result, 'webp', 'image/webp');
          assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
          assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
          assert.deepEqual(await sharp(bytes).ensureAlpha().raw().toBuffer(), pixels);
        });
      }
    }
    for (const wire of ['json', 'url']) {
      await t.test(`existing WebP ${wire} results retain their exact bytes`, async () => {
        const result = await complete({}, { wire, format: 'webp' });
        assert.equal(result.downloads.length, wire === 'url' ? 1 : 0);
        for (const download of result.downloads) assert.equal(download.authorization, undefined);
        assert.deepEqual(await storedResult(result, 'webp', 'image/webp'), webp);
      });
    }
    for (const [name, response] of [
      ['unavailable result URL', { wire: 'url', format: 'png', missing: true }],
      ['invalid image bytes', { wire: 'json', format: 'invalid' }],
    ]) {
      await t.test(`${name} fails without another image generation`, async () => {
        const result = await complete({}, response);
        assert.equal(result.task.status, 'failed');
        assert.ok(result.task.error);
        assert.equal(result.downloads.length, response.wire === 'url' ? 1 : 0);
        for (const download of result.downloads) assert.equal(download.authorization, undefined);
      });
    }
    await t.test('other output selections and text generation retain the actual upstream bytes', async () => {
      for (const [overrides, format, bytes, mime] of [
        [{ gptImageOutputFormat: 'png' }, 'webp', webp, 'image/webp'],
        [{ gptImageOutputFormat: 'jpeg' }, 'png', png, 'image/png'],
        [{ mode: 'text-to-image', images: [] }, 'png', png, 'image/png'],
      ]) {
        const result = await complete(overrides, { wire: 'json', format });
        assert.deepEqual(await storedResult(result, format, mime), bytes);
      }
    });
    await t.test('PNG edit URL results retain their original address without backend download', async () => {
      const result = await complete({ gptImageOutputFormat: 'png' }, { wire: 'url', format: 'png', missing: true });
      assert.equal(result.task.status, 'completed', result.task.error);
      assert.deepEqual(result.task.result.images, [`URL:${upstreamUrl}/result/missing.png`]);
      assert.equal(result.downloads.length, 0);
    });
  } finally {
    if (child.connected) {
      const exited = waitForExit(child);
      child.send({ type: 'stop' });
      await exited;
    } else if (!child.killed) child.kill('SIGKILL');
    child.stdout?.destroy(); child.stderr?.destroy();
    await closeServer(upstream);
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows may retain SQLite handles briefly after child exit. */ }
  }
});

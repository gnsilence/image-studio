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
      { name: 'text generation at 1.5K', count: 1, refs: 0, size: '1.5K', quality: 'low', ratio: '5:2' },
      { name: 'single reference edit', count: 1, refs: 1, size: '2K', quality: 'medium', ratio: '9:19.5' },
      { name: 'five references and ten outputs', count: 10, refs: 5, size: '2K', quality: 'auto', ratio: 'auto' },
      { name: 'all Base64 batch outputs are stored', count: 3, refs: 0, size: '1K', quality: 'medium', ratio: '21:9', base64: true },
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
          response_format: 'url',
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

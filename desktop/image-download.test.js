const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { fetchRemoteImage } = require('./image-download');

test('downloads image bytes without requiring cross-origin response headers', async t => {
  const image = Buffer.from('89504e470d0a1a0a', 'hex');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'image/png' });
    response.end(image);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const result = await fetchRemoteImage(`http://127.0.0.1:${server.address().port}/image`, fetch);

  assert.equal(result.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(result.data), image);
});

test('rejects non-HTTP image sources before making a request', async () => {
  let requests = 0;
  await assert.rejects(fetchRemoteImage('file:///image.png', async () => {
    requests++;
  }), /HTTP\/HTTPS/);
  assert.equal(requests, 0);
});

test('preserves HTTP failures and does not return an error page as an image', async () => {
  await assert.rejects(fetchRemoteImage('https://images.example/image.png', async () => (
    new Response('expired', { status: 403 })
  )), /HTTP 403/);
});

test('rejects interrupted image downloads', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.error(new Error('download interrupted'));
    },
  });
  await assert.rejects(fetchRemoteImage('https://images.example/image.png', async () => (
    new Response(body)
  )), /download interrupted/);
});

test('rejects empty image downloads', async () => {
  await assert.rejects(fetchRemoteImage('https://images.example/image.png', async () => (
    new Response(null)
  )), /图片内容为空/);
});

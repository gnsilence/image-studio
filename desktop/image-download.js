const IMAGE_DOWNLOAD_IDLE_TIMEOUT_MS = 120_000;

async function fetchRemoteImage(url, fetchImage) {
  const parsedUrl = new URL(url);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('仅支持 HTTP/HTTPS 图片地址');
  }

  const controller = new AbortController();
  let timeout;
  const resetTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_IDLE_TIMEOUT_MS);
  };

  try {
    resetTimeout();
    const response = await fetchImage(parsedUrl.href, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const mimeType = response.headers.get('content-type') || 'image/png';
    const chunks = [];
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        resetTimeout();
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(Buffer.from(value));
      }
    } else {
      resetTimeout();
      chunks.push(Buffer.from(await response.arrayBuffer()));
    }
    const data = Buffer.concat(chunks);
    if (!data.length) throw new Error('图片内容为空');
    return { data: new Uint8Array(data), mimeType };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { fetchRemoteImage };

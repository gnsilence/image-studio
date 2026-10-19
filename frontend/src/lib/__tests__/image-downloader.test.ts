import { afterEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import type { NovaDesktopBridge } from '@/lib/desktop-bridge';
import {
  downloadAndStoreImages,
  fetchImageAsBlob,
  getStoredBlob,
  type ImageDownloadProgressItem,
} from '@/lib/image-downloader';

function makeStream(chunks: number[][], failAtIndex?: number): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAtIndex !== undefined && index === failAtIndex) {
        controller.error(new Error('stream failed'));
        return;
      }
      const chunk = chunks[index];
      if (!chunk) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(new Uint8Array(chunk));
    },
  });
}

function mockImageFetch(response: Response): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  delete window.novaDesktop;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchImageAsBlob', () => {
  it('按 Content-Length 上报流式下载进度', async () => {
    const progress: Array<{ loadedBytes: number; totalBytes?: number; percent?: number }> = [];
    mockImageFetch(new Response(makeStream([[1, 2], [3, 4]]), {
      headers: {
        'content-length': '4',
        'content-type': 'image/png',
      },
    }));

    const blob = await fetchImageAsBlob('/image.png', 1, item => progress.push(item));

    expect(blob.size).toBe(4);
    expect(progress).toEqual([
      { loadedBytes: 0, totalBytes: 4, percent: 0 },
      { loadedBytes: 2, totalBytes: 4, percent: 50 },
      { loadedBytes: 4, totalBytes: 4, percent: 100 },
    ]);
  });

  it('未知总大小时仍上报已下载字节', async () => {
    const progress: Array<{ loadedBytes: number; totalBytes?: number; percent?: number }> = [];
    mockImageFetch(new Response(makeStream([[1], [2, 3]]), {
      headers: { 'content-type': 'image/png' },
    }));

    const blob = await fetchImageAsBlob('/image.png', 1, item => progress.push(item));

    expect(blob.size).toBe(3);
    expect(progress.at(-1)).toMatchObject({ loadedBytes: 3 });
    expect(progress.at(-1)?.totalBytes).toBeUndefined();
    expect(progress.at(-1)?.percent).toBeUndefined();
  });

  it('HTTP 非 2xx 时抛出状态码错误', async () => {
    mockImageFetch(new Response('bad gateway', { status: 502 }));

    await expect(fetchImageAsBlob('/image.png', 1)).rejects.toThrow('HTTP 502');
  });

  it('body 读取中断时抛出流错误', async () => {
    const progress: Array<{ loadedBytes: number }> = [];
    mockImageFetch(new Response(makeStream([[1]], 1), {
      headers: { 'content-length': '2' },
    }));

    await expect(fetchImageAsBlob('/image.png', 1, item => progress.push(item))).rejects.toThrow('stream failed');
    expect(progress.some(item => item.loadedBytes === 1)).toBe(true);
  });

  it('远程图片跨域读取失败时通过桌面桥接读取完整图片', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const fetchImage = vi.fn().mockResolvedValue({
      data: new Uint8Array([1, 2, 3]),
      mimeType: 'image/webp',
    });
    window.novaDesktop = { images: { fetch: fetchImage } } as unknown as NovaDesktopBridge;
    const progress = vi.fn();

    const blob = await fetchImageAsBlob('https://imgen.x.ai/image.png', 1, progress);

    expect(fetchImage).toHaveBeenCalledWith('https://imgen.x.ai/image.png');
    expect(blob.type).toBe('image/webp');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(progress).toHaveBeenLastCalledWith({ loadedBytes: 3, totalBytes: 3, percent: 100 });
  });

  it('可以直接读取的图片继续使用前端下载', async () => {
    mockImageFetch(new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }));
    const fetchImage = vi.fn();
    window.novaDesktop = { images: { fetch: fetchImage } } as unknown as NovaDesktopBridge;

    const blob = await fetchImageAsBlob('https://images.example/image.png', 1);

    expect(blob.size).toBe(1);
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it('HTTP 错误不通过桌面桥接重复请求', async () => {
    mockImageFetch(new Response('expired', { status: 403 }));
    const fetchImage = vi.fn();
    window.novaDesktop = { images: { fetch: fetchImage } } as unknown as NovaDesktopBridge;

    await expect(fetchImageAsBlob('https://imgen.x.ai/image.png', 1)).rejects.toThrow('HTTP 403');
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it.each(['/image.png', 'blob:missing-image'])('本地图片读取失败时不交给远程桥接：%s', async url => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const fetchImage = vi.fn();
    window.novaDesktop = { images: { fetch: fetchImage } } as unknown as NovaDesktopBridge;

    await expect(fetchImageAsBlob(url, 1)).rejects.toThrow('Failed to fetch');
    expect(fetchImage).not.toHaveBeenCalled();
  });
});

describe('downloadAndStoreImages', () => {
  it('跨域图片经桌面网络读取后保存到本地历史文件', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:desktop-image') });
    const write = vi.fn().mockResolvedValue({});
    window.novaDesktop = {
      images: {
        fetch: vi.fn().mockResolvedValue({ data: new Uint8Array([1, 2]), mimeType: 'image/png' }),
      },
      files: { write },
    } as unknown as NovaDesktopBridge;

    const result = await downloadAndStoreImages('job-desktop', ['URL:https://imgen.x.ai/image.png'], { maxRetries: 1 });

    expect(write).toHaveBeenCalledWith('history', 'job-desktop-0', new Uint8Array([1, 2]), 'image/png');
    expect(result.successCount).toBe(1);
    expect(result.failCount).toBe(0);
    expect(result.items[0]).toMatchObject({ status: 'cached', loadedBytes: 2, percent: 100 });
  });

  it('IndexedDB 不可用时降级到内存缓存并保留进度结果', async () => {
    const progress: ImageDownloadProgressItem[] = [];
    vi.stubGlobal('indexedDB', undefined);
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:cached-0'),
      revokeObjectURL: vi.fn(),
    });
    mockImageFetch(new Response(makeStream([[1, 2]]), {
      headers: {
        'content-length': '2',
        'content-type': 'image/png',
      },
    }));

    const result = await downloadAndStoreImages('job-fallback', ['URL:/image.png'], {
      maxRetries: 1,
      onProgress: item => progress.push(item),
    });

    expect(result.successCount).toBe(1);
    expect(result.failCount).toBe(0);
    expect(result.blobUrls).toEqual(['blob:cached-0']);
    expect(result.items[0]).toMatchObject({ index: 0, status: 'cached', loadedBytes: 2, totalBytes: 2, percent: 100 });
    expect(progress.some(item => item.status === 'downloading' && item.percent === 100)).toBe(true);
    await expect(getStoredBlob('job-fallback', 0)).resolves.toMatchObject({ size: 2 });
  });
});

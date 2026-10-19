import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NovaDesktopBridge } from '@/lib/desktop-bridge';
import { downloadImagePayload, resolveImagePayloadToBlob } from '@/lib/image-actions';

afterEach(() => {
  delete window.novaDesktop;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockCrossOriginImage() {
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  const fetchImage = vi.fn().mockResolvedValue({
    data: new Uint8Array([1, 2, 3]),
    mimeType: 'image/png',
  });
  window.novaDesktop = { images: { fetch: fetchImage } } as unknown as NovaDesktopBridge;
  return fetchImage;
}

describe('remote image actions', () => {
  it('下载既有历史图片时也使用桌面读取通道', async () => {
    const fetchImage = mockCrossOriginImage();
    const createObjectURL = vi.fn(() => 'blob:download');
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
    let downloadedName: string | undefined;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloadedName = this.download;
    });

    await downloadImagePayload({
      name: 'grok-image',
      storedRef: { jobId: 'existing-job', imageRef: 'URL:https://imgen.x.ai/image.png', imageIndex: 0 },
      sourceKind: 'text-to-image',
    });

    expect(fetchImage).toHaveBeenCalledWith('https://imgen.x.ai/image.png');
    expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ size: 3, type: 'image/png' }));
    expect(click).toHaveBeenCalledOnce();
    expect(downloadedName).toBe('grok-image.png');
  });

  it('直接图片地址操作复用相同的跨域读取回退', async () => {
    const fetchImage = mockCrossOriginImage();

    const blob = await resolveImagePayloadToBlob({
      src: 'https://imgen.x.ai/image.png',
      sourceKind: 'manual',
    });

    expect(fetchImage).toHaveBeenCalledOnce();
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});

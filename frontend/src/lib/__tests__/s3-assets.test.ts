import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NovaDesktopBridge, S3ImageObject } from '@/lib/desktop-bridge';
import {
  getS3RootPrefix,
  getSelectionBlob,
  getSelectionId,
  listS3Folder,
  s3AssetSelection,
  uploadFileToS3,
} from '@/lib/s3-assets';

afterEach(() => {
  delete window.novaDesktop;
});

function installBridge() {
  const object: S3ImageObject = {
    key: 'images/team/sample.png',
    name: 'sample.png',
    mimeType: 'image/png',
    sizeBytes: 3,
    etag: 'v1',
  };
  const s3 = {
    listFolder: vi.fn(async () => ({ prefix: 'images/team/', folders: [], objects: [object] })),
    readObject: vi.fn(async () => ({
      id: 's3-original:test', namespace: 'cache', mimeType: 'image/png', sizeBytes: 3, sha256: 'hash', data: new Uint8Array([1, 2, 3]),
    })),
    uploadObject: vi.fn(async () => object),
  };
  window.novaDesktop = { platform: 'win32', s3 } as unknown as NovaDesktopBridge;
  return { object, s3 };
}

describe('S3 asset adapter', () => {
  it('normalizes the configured root prefix', () => {
    expect(getS3RootPrefix({ rootPrefix: '' })).toBe('');
    expect(getS3RootPrefix({ rootPrefix: '/images/team/' })).toBe('images/team/');
  });

  it('routes folder listing and object reads through the desktop bridge', async () => {
    const { object, s3 } = installBridge();
    const result = await listS3Folder('images/team/', 'next');
    const selection = s3AssetSelection(object);
    const blob = await getSelectionBlob(selection);
    expect(result.objects).toEqual([object]);
    expect(getSelectionId(selection)).toBe('s3:images/team/sample.png');
    expect(blob?.type).toBe('image/png');
    expect(blob?.size).toBe(3);
    expect(s3.listFolder).toHaveBeenCalledWith({ prefix: 'images/team/', continuationToken: 'next' });
    expect(s3.readObject).toHaveBeenCalledWith(object);
  });

  it('uploads original bytes to the current prefix', async () => {
    const { s3 } = installBridge();
    const file = {
      type: 'image/png',
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as Blob;
    await uploadFileToS3('images/team/', file, 'sample.png');
    expect(s3.uploadObject).toHaveBeenCalledWith(expect.objectContaining({
      prefix: 'images/team/',
      fileName: 'sample.png',
      mimeType: 'image/png',
      data: new Uint8Array([1, 2, 3]),
    }));
  });
});

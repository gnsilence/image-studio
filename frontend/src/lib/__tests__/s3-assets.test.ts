import { afterEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import type { ImageAsset } from '@/lib/asset-store';
import type { NovaDesktopBridge, S3ImageObject } from '@/lib/desktop-bridge';
import {
  getS3RootPrefix,
  getSelectionBlob,
  getSelectionId,
  listS3Folder,
  s3AssetSelection,
  uploadFileToS3,
  uploadLocalAssetToS3,
} from '@/lib/s3-assets';

afterEach(() => {
  delete window.novaDesktop;
  vi.unstubAllGlobals();
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
    uploadObject: vi.fn<NovaDesktopBridge['s3']['uploadObject']>().mockResolvedValue(object),
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

  it('uses the SVG MIME type when adding a local generated asset to S3', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    const { s3 } = installBridge();
    const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const asset = {
      id: 'generated-svg', blobKey: 'svg-hash', name: 'generated.png', mimeType: 'image/svg+xml',
    } as ImageAsset;
    window.novaDesktop!.records = { get: vi.fn().mockResolvedValue(asset) } as unknown as NovaDesktopBridge['records'];
    window.novaDesktop!.files = {
      read: vi.fn().mockResolvedValue({ mimeType: 'image/svg+xml', data: bytes }),
    } as unknown as NovaDesktopBridge['files'];
    await uploadLocalAssetToS3('images/team/', asset);
    expect(s3.uploadObject).toHaveBeenCalledWith(expect.objectContaining({
      fileName: 'generated.svg', mimeType: 'image/svg+xml',
    }));
    expect(Array.from(s3.uploadObject.mock.calls[0][0].data)).toEqual(Array.from(bytes));
  });
});

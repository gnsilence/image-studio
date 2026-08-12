import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3AssetBrowser } from '../S3AssetBrowser';
import type { NovaDesktopBridge, S3PublicConfig } from '@/lib/desktop-bridge';

vi.mock('@/lib/image-actions', () => ({
  dispatchImageActionToast: vi.fn(),
  runImageAction: vi.fn(async () => {}),
}));

const baseConfig: S3PublicConfig = {
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'assets',
  rootPrefix: 'images',
  forcePathStyle: false,
  hasAccessKeyId: true,
  hasSecretAccessKey: true,
  hasSessionToken: false,
};

function installBridge(config: S3PublicConfig, listFolder = vi.fn()) {
  const s3 = {
    getConfig: vi.fn(async () => config),
    listFolder,
    readThumbnail: vi.fn(async () => ({
      id: 's3-thumb:test',
      namespace: 'cache',
      mimeType: 'image/webp',
      sizeBytes: 3,
      sha256: 'hash',
      data: new Uint8Array([1, 2, 3]),
    })),
    readObject: vi.fn(async () => ({
      id: 's3-original:test',
      namespace: 'cache',
      mimeType: 'image/png',
      sizeBytes: 3,
      sha256: 'hash',
      data: new Uint8Array([1, 2, 3]),
    })),
  };
  window.novaDesktop = { platform: 'win32', s3 } as unknown as NovaDesktopBridge;
  return s3;
}

describe('S3 asset browser', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:s3-thumbnail'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    delete window.novaDesktop;
    vi.restoreAllMocks();
  });

  it('offers the settings entry when credentials are not configured', async () => {
    const onConfigure = vi.fn();
    installBridge({ ...baseConfig, hasAccessKeyId: false, hasSecretAccessKey: false });

    render(<S3AssetBrowser onConfigure={onConfigure} />);

    fireEvent.click(await screen.findByRole('button', { name: '打开设置' }));
    expect(onConfigure).toHaveBeenCalledOnce();
  });

  it('loads one folder page and filters only the current page', async () => {
    const listFolder = vi.fn(async ({ prefix }: { prefix?: string }) => ({
      prefix: prefix || 'images/',
      folders: [{ name: 'team', prefix: 'images/team/' }],
      objects: [{
        key: 'images/sample.png',
        name: 'sample.png',
        mimeType: 'image/png',
        sizeBytes: 3,
        etag: 'v1',
      }],
    }));
    installBridge(baseConfig, listFolder);

    render(<S3AssetBrowser />);

    expect(await screen.findByText('sample.png')).toBeInTheDocument();
    expect(listFolder).toHaveBeenCalledWith({ prefix: 'images/', continuationToken: undefined });
    expect(screen.queryByTitle('删除')).not.toBeInTheDocument();
    expect(screen.queryByTitle('编辑')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('搜索当前目录'), { target: { value: 'missing' } });
    expect(screen.getByText('当前目录没有匹配的图片')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('搜索当前目录'), { target: { value: '' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'team' }).at(-1)!);
    await waitFor(() => expect(listFolder).toHaveBeenCalledWith({ prefix: 'images/team/', continuationToken: undefined }));
  });

  it('offers a direct image-to-image reference action in workspace mode', async () => {
    const { runImageAction } = await import('@/lib/image-actions');
    const listFolder = vi.fn(async () => ({
      prefix: 'images/',
      folders: [],
      objects: [{
        key: 'images/sample.png',
        name: 'sample.png',
        mimeType: 'image/png',
        sizeBytes: 3,
        etag: 'v1',
      }],
    }));
    installBridge(baseConfig, listFolder);

    render(<S3AssetBrowser mode="workspace" />);
    fireEvent.click(await screen.findByTitle('作为图生图参考'));

    await waitFor(() => expect(runImageAction).toHaveBeenCalledWith(
      'use-as-reference',
      expect.objectContaining({ name: 'sample.png', sourceLabel: 'S3 存储', sourceRef: 'images/sample.png' }),
    ));
  });
});

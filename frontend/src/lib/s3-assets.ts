'use client';

import { getAssetBlob, getAssetThumbnailBlob, type ImageAsset } from '@/lib/asset-store';
import { blobToBytes, storedFileToBlob } from '@/lib/desktop-binary';
import {
  getDesktopBridge,
  type S3Folder,
  type S3ImageObject,
  type S3ListResult,
  type S3PublicConfig,
} from '@/lib/desktop-bridge';

export type ImageAssetSelection =
  | { source: 'local'; asset: ImageAsset }
  | { source: 's3'; object: S3ImageObject };

export function localAssetSelection(asset: ImageAsset): ImageAssetSelection {
  return { source: 'local', asset };
}

export function s3AssetSelection(object: S3ImageObject): ImageAssetSelection {
  return { source: 's3', object };
}

export function getSelectionId(selection: ImageAssetSelection): string {
  return selection.source === 'local' ? `local:${selection.asset.id}` : `s3:${selection.object.key}`;
}

export function getSelectionName(selection: ImageAssetSelection): string {
  return selection.source === 'local' ? selection.asset.name : selection.object.name;
}

export function getSelectionMimeType(selection: ImageAssetSelection): string {
  return selection.source === 'local' ? selection.asset.mimeType : selection.object.mimeType;
}

export function getSelectionSize(selection: ImageAssetSelection): number {
  return selection.source === 'local' ? selection.asset.sizeBytes : selection.object.sizeBytes;
}

export async function getSelectionBlob(selection: ImageAssetSelection): Promise<Blob | null> {
  if (selection.source === 'local') return getAssetBlob(selection.asset.id);
  const desktop = getDesktopBridge();
  if (!desktop) return null;
  return storedFileToBlob(await desktop.s3.readObject(selection.object));
}

export async function getSelectionThumbnailBlob(selection: ImageAssetSelection): Promise<Blob | null> {
  if (selection.source === 'local') return getAssetThumbnailBlob(selection.asset);
  const desktop = getDesktopBridge();
  if (!desktop) return null;
  return storedFileToBlob(await desktop.s3.readThumbnail(selection.object));
}

export async function getS3Config(): Promise<S3PublicConfig | null> {
  const desktop = getDesktopBridge();
  return desktop ? desktop.s3.getConfig() : null;
}

export function getS3RootPrefix(config: Pick<S3PublicConfig, 'rootPrefix'>): string {
  const root = config.rootPrefix.trim().replace(/^\/+|\/+$/g, '');
  return root ? `${root}/` : '';
}

export async function listS3Folder(prefix?: string, continuationToken?: string): Promise<S3ListResult> {
  const desktop = getDesktopBridge();
  if (!desktop) throw new Error('S3 素材仅在桌面端可用');
  return desktop.s3.listFolder({ prefix, continuationToken });
}

export async function uploadFileToS3(prefix: string, file: Blob, fileName: string): Promise<S3ImageObject> {
  const desktop = getDesktopBridge();
  if (!desktop) throw new Error('S3 素材仅在桌面端可用');
  return desktop.s3.uploadObject({
    prefix,
    fileName,
    mimeType: file.type || 'application/octet-stream',
    data: await blobToBytes(file),
  });
}

export async function uploadLocalAssetToS3(prefix: string, asset: ImageAsset): Promise<S3ImageObject> {
  const blob = await getAssetBlob(asset.id);
  if (!blob) throw new Error('本地素材文件不存在');
  return uploadFileToS3(prefix, blob, asset.name);
}

export async function createS3Folder(prefix: string, name: string): Promise<S3Folder> {
  const desktop = getDesktopBridge();
  if (!desktop) throw new Error('S3 素材仅在桌面端可用');
  return desktop.s3.createFolder({ prefix, name });
}

export async function downloadS3Object(object: S3ImageObject): Promise<{ canceled: boolean; filePath?: string }> {
  const desktop = getDesktopBridge();
  if (!desktop) throw new Error('S3 素材仅在桌面端可用');
  return desktop.s3.downloadObject(object);
}

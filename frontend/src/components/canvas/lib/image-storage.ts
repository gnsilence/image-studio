"use client";

import localforage from "localforage";

import { nanoid } from "nanoid";
import { readImageMeta } from "./image-utils";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { blobToBytes, storedFileToBlob } from "@/lib/desktop-binary";

export type UploadedImage = {
  url: string;
  storageKey: string;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
};

const store = localforage.createInstance({ name: "nova-image", storeName: "canvas_image_files" });
const objectUrls = new Map<string, string>();

/** 本地存储图片 blob（命名沿用 uploadImage，但全程纯前端 IndexedDB，不上传服务端）。 */
export async function uploadImage(input: string | Blob): Promise<UploadedImage> {
  const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
  const storageKey = `image:${nanoid()}`;
  const desktop = getDesktopBridge();
  if (desktop) await desktop.files.write('canvas', storageKey, await blobToBytes(blob), blob.type || 'image/png');
  else await store.setItem(storageKey, blob);
  const url = URL.createObjectURL(blob);
  objectUrls.set(storageKey, url);
  const meta = await readImageMeta(url);
  return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType };
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
  if (!storageKey) return fallback;
  const cached = objectUrls.get(storageKey);
  if (cached) return cached;
  const desktop = getDesktopBridge();
  const stored = desktop ? await desktop.files.read('canvas', storageKey) : null;
  const blob = stored ? storedFileToBlob(stored) : await store.getItem<Blob>(storageKey);
  if (!blob) return fallback;
  const url = URL.createObjectURL(blob);
  objectUrls.set(storageKey, url);
  return url;
}

export async function getImageBlob(storageKey: string) {
  const desktop = getDesktopBridge();
  if (desktop) {
    const stored = await desktop.files.read('canvas', storageKey);
    return stored ? storedFileToBlob(stored) : null;
  }
  return store.getItem<Blob>(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
  const desktop = getDesktopBridge();
  if (desktop) await desktop.files.write('canvas', storageKey, await blobToBytes(blob), blob.type || 'image/png');
  else await store.setItem(storageKey, blob);
  const url = URL.createObjectURL(blob);
  objectUrls.set(storageKey, url);
  return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }): Promise<string> {
  // 优先用 storageKey（IndexedDB），避免刷新后 blob: URL 失效导致 fetch 失败
  if (image.storageKey) {
    const blob = await getImageBlob(image.storageKey);
    if (blob) return blobToDataUrl(blob);
  }
  const url = image.dataUrl || image.url || "";
  if (!url) throw new Error("图片数据不可用（可能已刷新丢失），请重新上传或从素材库导入");
  if (url.startsWith("data:")) return url;
  // blob: URL 可能已失效（刷新后），尝试 fetch
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return blobToDataUrl(await response.blob());
  } catch {
    throw new Error("图片加载失败（blob URL 可能已失效），请重新上传或从素材库导入");
  }
}

export async function deleteStoredImages(keys: Iterable<string>) {
  await Promise.all(
    Array.from(new Set(keys)).map(async (key) => {
      const url = objectUrls.get(key);
      if (url) URL.revokeObjectURL(url);
      objectUrls.delete(key);
      const desktop = getDesktopBridge();
      if (desktop) await desktop.files.delete('canvas', key);
      else await store.removeItem(key);
    }),
  );
}

export async function cleanupUnusedImages(usedData: unknown) {
  const usedKeys = collectImageStorageKeys(usedData);
  const unused: string[] = [];
  const desktop = getDesktopBridge();
  if (desktop) {
    const files = await desktop.files.list('canvas');
    for (const file of files) if (!usedKeys.has(file.id)) unused.push(file.id);
  } else {
    await store.iterate((_value, key) => {
      if (!usedKeys.has(key)) unused.push(key);
    });
  }
  await deleteStoredImages(unused);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
  if (!value || typeof value !== "object") return keys;
  if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
  Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
  return keys;
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(blob);
  });
}

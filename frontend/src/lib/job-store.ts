import type { GptImageBackground, GptImageQuality, GptImageStyle } from '@/lib/model-capabilities';
import { makeStoredBlobRef, type ImageDownloadProgressItem } from '@/lib/image-downloader';
import { openImageDb, IMG_STORE } from '@/lib/image-db';
import { getDesktopBridge } from '@/lib/desktop-bridge';
import { blobToBytes, blobToDataUrl, dataUrlToBlob, storedFileToBlob } from '@/lib/desktop-binary';
import { runtimeStorage } from '@/lib/runtime-storage';

export type Mode = 'text-to-image' | 'image-to-image' | 'prompt-gallery';
export type OutputSize = 'auto' | '512' | '1K' | '2K' | '4K';
export type AspectRatio = 'auto' | '1:1' | '1:4' | '1:8' | '2:3' | '3:2' | '3:4' | '4:1' | '4:3' | '4:5' | '5:4' | '8:1' | '9:16' | '16:9' | '21:9';

export interface RefImageData {
  id: string;
  name: string;
  dataUrl: string;
  mimeType: string;
  badge?: string;
}

export interface ImageDownloadProgress {
  total: number;
  completed: number;
  failed: number;
  items: ImageDownloadProgressItem[];
}

export interface StoredJob {
  id: string;
  status: 'queued' | '排队中' | 'processing' | 'completed' | 'failed';
  mode: Mode;
  prompt: string;
  output_size: OutputSize;
  custom_size?: string;
  temperature: number;
  aspect_ratio: AspectRatio;
  model: string;
  gptImageQuality?: GptImageQuality;
  gptImageStyle?: GptImageStyle;
  gptImageBackground?: GptImageBackground;
  created_at: string;
  error?: string;
  networkError?: boolean;
  /** true 表示后端明确判定该失败任务不可恢复（API 错误 / 服务器重启 / 已过期 / 已删除）。
   * 仅在 status==='failed' 时有意义；undefined 视为非终态，允许"查看进度" */
  terminal?: boolean;
  warning?: string;
  imageData?: string;
  parallelCount?: number;
  images?: string[];
  serverTaskId?: string;
  serverTaskAcked?: boolean;
  refImages?: RefImageData[];
  originalPrompt?: string;
  blobUrls?: string[];
  imageDownloadProgress?: ImageDownloadProgress;
}

const JOBS_KEY = 'nova-jobs';

// 复用单例连接层；保留这两个导出名以兼容现有调用方（如 useWorkspaceJobs）。
export { IMG_STORE };
export const openDB = openImageDb;

export function getImageSrc(imageData: string): string {
  if (imageData.startsWith('blob:')) {
    return imageData;
  }

  if (imageData.startsWith('URL:')) {
    return imageData.substring(4);
  }

  if (imageData.startsWith('MULTI_URL:')) {
    return imageData.substring(10).split('|||')[0];
  }

  if (imageData.startsWith('IDB:')) {
    return '';
  }

  return `data:image/png;base64,${imageData}`;
}

function toPersistedImageRefs(result: StoredJob): string[] | undefined {
  return result.images?.map((image, index) => (
    image.startsWith('blob:') ? makeStoredBlobRef(result.id, index) : image
  ));
}

export async function saveImage(result: StoredJob) {
  const desktop = getDesktopBridge();
  if (desktop) {
    const refImages = await Promise.all((result.refImages || []).map(async (refImage, index) => {
      const blob = dataUrlToBlob(refImage.dataUrl);
      if (!blob) return refImage;
      await desktop.files.write('history', `${result.id}:ref:${index}`, await blobToBytes(blob), blob.type || refImage.mimeType);
      return { ...refImage, dataUrl: '' };
    }));
    const images = toPersistedImageRefs(result);
    await desktop.records.put('image-records', result.id, {
      id: result.id,
      jobId: result.id,
      status: result.status,
      imageData: images?.[0] || result.imageData,
      images,
      refImages,
      error: result.error,
    });
    return;
  }
  const db = await openDB();
  if (!db) return;

  const images = toPersistedImageRefs(result);

  return new Promise<void>((resolve) => {
    const tx = db.transaction(IMG_STORE, 'readwrite');
    tx.objectStore(IMG_STORE).put({
      id: result.id,
      jobId: result.id,
      status: result.status,
      imageData: images?.[0] || result.imageData,
      images,
      refImages: result.refImages,
      error: result.error,
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function deleteImage(jobId: string) {
  const desktop = getDesktopBridge();
  if (desktop) {
    const record = await desktop.records.get<StoredJob>('image-records', jobId);
    await Promise.all((record?.refImages || []).map((_, index) => desktop.files.delete('history', `${jobId}:ref:${index}`)));
    await desktop.records.delete('image-records', jobId);
    return;
  }
  const db = await openDB();
  if (!db) return;

  return new Promise<void>((resolve) => {
    const tx = db.transaction(IMG_STORE, 'readwrite');
    tx.objectStore(IMG_STORE).delete(jobId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export function loadJobs(): StoredJob[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(runtimeStorage.getItem(JOBS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveJobs(jobs: StoredJob[]) {
  if (typeof window === 'undefined') return;

  const lightweight = jobs.map(({ ...job }) => {
    delete job.imageData;
    delete job.images;
    delete job.refImages;
    delete job.blobUrls;
    delete job.imageDownloadProgress;
    return job;
  });
  try {
    runtimeStorage.setItem(JOBS_KEY, JSON.stringify(lightweight));
  } catch {
    // Keep the in-memory job list usable when storage quota or browser policy blocks writes.
  }
}

export async function loadStoredImages(): Promise<StoredJob[]> {
  const desktop = getDesktopBridge();
  if (desktop) {
    const entries = await desktop.records.list<StoredJob>('image-records');
    return Promise.all(entries.map(async entry => {
      const record = entry.value;
      const refImages = await Promise.all((record.refImages || []).map(async (refImage, index) => {
        if (refImage.dataUrl) return refImage;
        const stored = await desktop.files.read('history', `${record.id}:ref:${index}`);
        if (!stored) return refImage;
        return { ...refImage, dataUrl: await blobToDataUrl(storedFileToBlob(stored)) };
      }));
      return { ...record, refImages };
    }));
  }

  const db = await openDB();
  if (!db) return [];
  return new Promise(resolve => {
    const request = db.transaction(IMG_STORE, 'readonly').objectStore(IMG_STORE).getAll();
    request.onsuccess = () => resolve((request.result as StoredJob[]) || []);
    request.onerror = () => resolve([]);
  });
}

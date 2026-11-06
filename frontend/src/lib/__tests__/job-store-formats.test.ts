import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NovaDesktopBridge } from '@/lib/desktop-bridge';
import { deleteImage, getImageSrc, loadStoredImages, saveImage, saveJobs, type StoredJob } from '@/lib/job-store';

vi.mock('@/lib/desktop-binary', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/desktop-binary')>();
  return {
    ...original,
    blobToBytes: (blob: Blob) => new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = reject;
      reader.readAsArrayBuffer(blob);
    }),
  };
});

const overlay = { data: btoa('overlay-png'), mimeType: 'image/png' as const };
const job: StoredJob = {
  id: 'edit-26', status: 'completed', mode: 'image-to-image', prompt: 'recolor vase',
  model: 'gpt-image-2.6-sunburst', output_size: '1K', aspect_ratio: '1:1', temperature: 1,
  created_at: '2026-11-05T12:00:00Z', gptImageOutputFormat: 'webp', gptImageComplexity: 'low',
  gptImageMarkup: overlay, images: ['URL:/result.webp'],
};

afterEach(() => { delete window.novaDesktop; localStorage.clear(); vi.restoreAllMocks(); });

describe('image format and markup history', () => {
  it.each(['image/svg+xml', 'image/gif', 'image/webp', 'image/jpeg'])('preserves %s data URLs for previews', mime => {
    const src = `data:${mime};base64,${btoa('original bytes')}`;
    expect(getImageSrc(src)).toBe(src);
    expect(getImageSrc('legacy-png')).toBe('data:image/png;base64,legacy-png');
  });

  it('keeps metadata in lightweight history without copying the overlay bytes', () => {
    saveJobs([job]);
    const [saved] = JSON.parse(localStorage.getItem('nova-jobs')!);
    expect(saved).toMatchObject({ gptImageOutputFormat: 'webp', gptImageComplexity: 'low' });
    expect(saved).not.toHaveProperty('gptImageMarkup');
  });

  it('stores, restores and deletes the separate desktop markup file', async () => {
    const files = new Map<string, { data: Uint8Array; mimeType: string }>();
    const records = new Map<string, StoredJob>();
    const write = vi.fn(async (_namespace: string, id: string, data: Uint8Array, mimeType: string) => { files.set(id, { data, mimeType }); });
    window.novaDesktop = {
      files: {
        write,
        read: vi.fn(async (_namespace: string, id: string) => files.get(id) || null),
        delete: vi.fn(async (_namespace: string, id: string) => { files.delete(id); }),
      },
      records: {
        put: vi.fn(async (_namespace: string, id: string, record: StoredJob) => { records.set(id, record); }),
        get: vi.fn(async (_namespace: string, id: string) => records.get(id)),
        list: vi.fn(async () => [...records.values()].map(value => ({ value }))),
        delete: vi.fn(async (_namespace: string, id: string) => { records.delete(id); }),
      },
    } as unknown as NovaDesktopBridge;
    await saveImage(job);
    expect(write).toHaveBeenCalledWith('history', 'edit-26:markup', expect.any(Uint8Array), 'image/png');
    expect(Array.from(files.get('edit-26:markup')!.data)).toEqual(Array.from(new TextEncoder().encode('overlay-png')));
    expect(records.get(job.id)?.gptImageMarkup?.data).toBe('');
    expect((await loadStoredImages())[0].gptImageMarkup).toEqual(overlay);
    await deleteImage(job.id);
    expect(files.size).toBe(0);
    expect(records.size).toBe(0);
  });
});

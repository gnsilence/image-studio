'use client';

import { useSyncExternalStore } from 'react';
import type { NovaTaskProgress } from '@/lib/ccode-task-client';

// Live transfer progress per server task. Kept outside the job list so the once-per-second updates never
// re-render the whole list or rewrite the stored jobs.
const progressByTask = new Map<string, NovaTaskProgress>();
const listeners = new Set<() => void>();

export function setTaskProgress(taskId: string, progress: NovaTaskProgress | undefined): void {
  if (progress) {
    progressByTask.set(taskId, progress);
  } else if (!progressByTask.delete(taskId)) {
    return;
  }
  for (const listener of listeners) listener();
}

export function getTaskProgress(taskId: string | undefined): NovaTaskProgress | undefined {
  return taskId ? progressByTask.get(taskId) : undefined;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTaskProgress(taskId: string | undefined): NovaTaskProgress | undefined {
  return useSyncExternalStore(subscribe, () => getTaskProgress(taskId), () => undefined);
}

export function formatTransferBytes(bytes: number): string {
  const mb = bytes / 1048576;
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

export function formatTransferSpeed(bytesPerSecond: number): string {
  return bytesPerSecond >= 1048576
    ? `${(bytesPerSecond / 1048576).toFixed(1)} MB/s`
    : `${Math.max(0, Math.round(bytesPerSecond / 1024))} KB/s`;
}

/** One-line description of where a running task is, e.g. "接收中 1.2 / 8.3 MB · 32 KB/s". */
export function describeTaskProgress(progress: NovaTaskProgress | undefined): string | null {
  if (!progress) return null;
  if (progress.phase === 'generating') return '等待上游生成';
  const label = progress.phase === 'downloading' ? '从图片地址下载' : '接收中';
  const size = progress.totalBytes && progress.receivedBytes <= progress.totalBytes
    ? `${formatTransferBytes(progress.receivedBytes)} / ${formatTransferBytes(progress.totalBytes)}`
    : formatTransferBytes(progress.receivedBytes);
  return `${label} ${size} · ${formatTransferSpeed(progress.bytesPerSecond)}`;
}

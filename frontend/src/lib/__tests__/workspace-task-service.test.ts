import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNovaTask, resolveImageTaskProvider, type NovaTaskResponse } from '@/lib/ccode-task-client';
import type { StoredJob } from '@/lib/job-store';
import { BUILTIN_IMAGE_PRESETS, DEFAULT_DEFAULTS } from '@/lib/nova-models';
import {
  finalizeCompletedServerTask,
  submitTextToImage,
  type SubmitActions,
} from '@/lib/workspace-task-service';
vi.mock('@/lib/ccode-task-client', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/ccode-task-client')>();
  return {
    ...actual,
    createNovaTask: vi.fn(),
    resolveImageTaskProvider: vi.fn(),
  };
});

const mockedCreateNovaTask = vi.mocked(createNovaTask);
const mockedResolveImageTaskProvider = vi.mocked(resolveImageTaskProvider);

function makeJob(overrides: Partial<StoredJob> = {}): StoredJob {
  return {
    id: 'job-1',
    status: 'processing',
    mode: 'text-to-image',
    prompt: 'prompt',
    output_size: '1K',
    temperature: 1,
    aspect_ratio: '1:1',
    model: 'gemini-3-pro-image-preview',
    created_at: '2026-06-07T00:00:00.000Z',
    serverTaskId: 'task-1',
    ...overrides,
  };
}

function makeCompletedTask(images: string[]): NovaTaskResponse {
  return {
    id: 'task-1',
    status: 'completed',
    result: { images },
  };
}

function createActions(initialJob: StoredJob): { actions: SubmitActions; getJob: () => StoredJob } {
  let currentJob = initialJob;
  const actions: SubmitActions = {
    addJob: vi.fn(),
    replaceJob: vi.fn((_jobId, updater) => {
      currentJob = updater(currentJob);
    }),
    completeJob: vi.fn(async (_jobId, job) => {
      currentJob = job;
    }),
    failJob: vi.fn(async (_jobId, error) => {
      currentJob = { ...currentJob, status: 'failed', error };
    }),
  };

  return {
    actions,
    getJob: () => currentJob,
  };
}

beforeEach(() => {
  localStorage.clear();
  const preset = BUILTIN_IMAGE_PRESETS['gpt-image-2'];
  localStorage.setItem('nova-model-registry', JSON.stringify({
    imageModels: [{ ...preset, apiKey: 'test-api-key', builtinPreset: preset.id }],
    textModels: [],
    defaults: DEFAULT_DEFAULTS,
  }));
  mockedCreateNovaTask.mockReset();
  mockedCreateNovaTask.mockResolvedValue('task-advanced-1');
  mockedResolveImageTaskProvider.mockReset();
  mockedResolveImageTaskProvider.mockReturnValue({
    apiKey: 'test-api-key',
    baseUrl: 'https://api.openai.com',
    protocol: 'openai',
    modelId: 'gpt-image-2',
  });
});

describe('submitTextToImage', () => {
  it('passes GPT Image advanced params into createNovaTask payload', async () => {
    const job = makeJob();
    const { actions, getJob } = createActions(job);

    await submitTextToImage({
      prompts: ['cut out subject'],
      outputSize: '1K',
      aspectRatio: '1:1',
      temperature: 1,
      model: 'gpt-image-2',
      gptImageQuality: 'high',
      gptImageStyle: 'vivid',
      gptImageBackground: 'transparent',
      parallelCount: 1,
    }, actions, vi.fn());

    expect(mockedCreateNovaTask).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'test-api-key',
      mode: 'text-to-image',
      model: 'gpt-image-2',
      gptImageQuality: 'high',
      gptImageStyle: 'vivid',
      gptImageBackground: 'transparent',
    }));
    expect(getJob().serverTaskId).toBe('task-advanced-1');
  });
});

describe('finalizeCompletedServerTask', () => {
  it('保留后端返回的 URL 图片结果，不再触发前端下载缓存', async () => {
    const job = makeJob();
    const { actions, getJob } = createActions(job);

    await finalizeCompletedServerTask(job, makeCompletedTask(['URL:/api/nova/images/task-1/0']), actions);

    expect(actions.completeJob).toHaveBeenCalledTimes(1);
    expect(getJob().images).toEqual(['URL:/api/nova/images/task-1/0']);
  });

  it('多张 URL 图片也直接保留原始引用', async () => {
    const job = makeJob();
    const { actions, getJob } = createActions(job);

    await finalizeCompletedServerTask(job, makeCompletedTask([
      'URL:/api/nova/images/task-1/0',
      'URL:/api/nova/images/task-1/1',
    ]), actions);

    expect(getJob().images).toEqual([
      'URL:/api/nova/images/task-1/0',
      'URL:/api/nova/images/task-1/1',
    ]);
    expect(getJob().warning).toBeUndefined();
  });
});

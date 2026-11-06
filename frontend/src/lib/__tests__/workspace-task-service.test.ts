import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNovaTask, resolveImageTaskProvider, type NovaTaskResponse } from '@/lib/ccode-task-client';
import { downloadAndStoreImages } from '@/lib/image-downloader';
import type { StoredJob } from '@/lib/job-store';
import { BUILTIN_IMAGE_PRESETS, DEFAULT_DEFAULTS } from '@/lib/nova-models';
import {
  finalizeCompletedServerTask,
  submitImageToImage,
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
vi.mock('@/lib/image-downloader', () => ({
  downloadAndStoreImages: vi.fn(),
  makeStoredBlobRef: (jobId: string, imageIndex: number) => `IDB:${jobId}-${imageIndex}`,
}));

const mockedCreateNovaTask = vi.mocked(createNovaTask);
const mockedResolveImageTaskProvider = vi.mocked(resolveImageTaskProvider);
const mockedDownloadAndStoreImages = vi.mocked(downloadAndStoreImages);

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
  mockedDownloadAndStoreImages.mockReset();
  mockedDownloadAndStoreImages.mockResolvedValue({
    successCount: 1,
    failCount: 0,
    blobUrls: ['blob:cached-0'],
    items: [{ index: 0, status: 'cached', loadedBytes: 1 }],
  });
});

describe('submitTextToImage', () => {
  it('submits native GIF controls using auto size and stores the same normalized parameters', async () => {
    const { actions } = createActions(makeJob());
    mockedResolveImageTaskProvider.mockReturnValue({
      apiKey: 'test-api-key', baseUrl: 'https://api.openai.com', protocol: 'openai', modelId: 'gpt-image-2.6-flare',
    });
    await submitTextToImage({
      prompts: ['animate a flower'], outputSize: '4K', customSize: '4096x4096', aspectRatio: '1:1',
      temperature: 1, model: 'gpt-image-2.6-flare', gptImageQuality: 'max',
      gptImageStyle: 'auto', gptImageBackground: 'auto', gptImageOutputFormat: 'gif',
      gptImageComplexity: 'medium', gptImageFrameCount: 50, gptImageFrameDurationMs: 5, parallelCount: 1,
    }, actions, vi.fn());
    const expected = {
      gptImageOutputFormat: 'gif', gptImageComplexity: 'medium', gptImageFrameCount: 16,
      gptImageFrameDurationMs: 20, gptImageQuality: 'max',
    };
    expect(actions.addJob).toHaveBeenCalledWith(expect.objectContaining({
      ...expected, output_size: 'auto', custom_size: undefined, aspect_ratio: 'auto',
    }));
    expect(mockedCreateNovaTask).toHaveBeenCalledWith(expect.objectContaining({
      ...expected, outputSize: 'auto', customSize: undefined, aspectRatio: 'auto',
    }));
  });

  it('does not send stale 2.6 controls after switching to a previous model', async () => {
    const { actions } = createActions(makeJob());
    await submitTextToImage({
      prompts: ['photo'], outputSize: '1K', aspectRatio: '1:1', temperature: 1, model: 'gpt-image-2',
      gptImageQuality: 'max', gptImageStyle: 'auto', gptImageBackground: 'auto',
      gptImageOutputFormat: 'gif', gptImageComplexity: 'low', parallelCount: 1,
    }, actions, vi.fn());
    expect(mockedCreateNovaTask.mock.calls[0][0]).not.toHaveProperty('gptImageOutputFormat');
    expect(mockedCreateNovaTask.mock.calls[0][0].gptImageQuality).toBe('auto');
  });

  it('forwards a markup PNG for 2.6 edits and rejects SVG edit requests', async () => {
    const { actions } = createActions(makeJob());
    const input = {
      prompt: 'move the marked object', files: [], outputSize: '1K' as const, aspectRatio: '1:1' as const,
      temperature: 1, model: 'gpt-image-2.6-sunburst', gptImageQuality: 'xhigh' as const,
      gptImageStyle: 'auto' as const, gptImageBackground: 'auto' as const,
      gptImageMarkup: { data: 'AA==', mimeType: 'image/png' as const }, parallelCount: 1 as const,
    };
    await submitImageToImage(input, actions, vi.fn());
    expect(mockedCreateNovaTask).toHaveBeenCalledWith(expect.objectContaining({ gptImageMarkup: input.gptImageMarkup }));
    mockedCreateNovaTask.mockClear();
    const onError = vi.fn();
    await submitImageToImage({ ...input, gptImageOutputFormat: 'svg' }, actions, onError);
    expect(mockedCreateNovaTask).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it.each(['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'] as const)(
    'submits reference-guided GIF animations with %s and retains normalized history parameters',
    async model => {
      const { actions } = createActions(makeJob());
      const onError = vi.fn();
      const files = [{
        id: 'ref-1', name: 'reference.png', dataUrl: 'data:image/png;base64,aW1hZ2U=', mimeType: 'image/png',
      }];
      mockedResolveImageTaskProvider.mockReturnValue({
        apiKey: 'test-api-key', baseUrl: 'https://api.openai.com', protocol: 'openai', modelId: model,
      });
      await submitImageToImage({
        prompt: 'animate this reference', files, outputSize: '4K', customSize: '3840x2160', aspectRatio: '16:9',
        temperature: 1, model, gptImageQuality: 'max', gptImageStyle: 'auto', gptImageBackground: 'auto',
        gptImageOutputFormat: 'gif', gptImageComplexity: 'medium', gptImageFrameCount: 12,
        gptImageFrameDurationMs: 120, parallelCount: 1,
      }, actions, onError);

      const expected = {
        mode: 'image-to-image', model, gptImageOutputFormat: 'gif', gptImageComplexity: 'medium',
        gptImageFrameCount: 12, gptImageFrameDurationMs: 120, gptImageQuality: 'max',
      };
      expect(onError).not.toHaveBeenCalled();
      expect(actions.addJob).toHaveBeenCalledWith(expect.objectContaining({
        ...expected, output_size: 'auto', custom_size: undefined, aspect_ratio: 'auto', refImages: files,
      }));
      expect(mockedCreateNovaTask).toHaveBeenCalledWith(expect.objectContaining({
        ...expected, outputSize: 'auto', customSize: undefined, aspectRatio: 'auto',
        images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }],
      }));
    },
  );

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

  it('forwards the GPT Image 2.5 upstream model ID', async () => {
    mockedResolveImageTaskProvider.mockReturnValue({
      apiKey: 'test-api-key',
      baseUrl: 'https://api.openai.com',
      protocol: 'openai',
      modelId: 'gpt-image-2.5',
    });
    const { actions } = createActions(makeJob({ model: 'image-2.5-config' }));

    await submitTextToImage({
      prompts: ['test 2.5'],
      outputSize: '2K',
      aspectRatio: '16:9',
      temperature: 1,
      model: 'image-2.5-config',
      gptImageQuality: 'high',
      gptImageStyle: 'natural',
      gptImageBackground: 'opaque',
      parallelCount: 1,
    }, actions, vi.fn());

    expect(mockedCreateNovaTask).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 'openai',
      model: 'gpt-image-2.5',
      outputSize: '2K',
      aspectRatio: '16:9',
    }));
  });

  it('forwards the Grok Imagine 2.0 URL setting', async () => {
    mockedResolveImageTaskProvider.mockReturnValue({
      apiKey: 'test-api-key',
      baseUrl: 'https://api.x.ai',
      protocol: 'grok',
      modelId: 'grok-imagine-image-2.0',
    });
    const { actions } = createActions(makeJob({ model: 'grok-image-2-config' }));

    await submitTextToImage({
      prompts: ['test URL response'],
      outputSize: '1K',
      aspectRatio: '1:1',
      temperature: 1,
      model: 'grok-image-2-config',
      gptImageQuality: 'auto',
      gptImageStyle: 'natural',
      gptImageBackground: 'opaque',
      parallelCount: 1,
      grokImageUseUrl: true,
    }, actions, vi.fn());

    expect(mockedCreateNovaTask).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 'grok',
      model: 'grok-imagine-image-2.0',
      grokImageUseUrl: true,
    }));
  });

  it('forwards the Grok Imagine 2.0 URL setting for reference edits', async () => {
    mockedResolveImageTaskProvider.mockReturnValue({
      apiKey: 'test-api-key',
      baseUrl: 'https://api.x.ai',
      protocol: 'grok',
      modelId: 'grok-imagine-image-2.0',
    });
    const { actions } = createActions(makeJob({ mode: 'image-to-image', model: 'grok-image-2-config' }));

    await submitImageToImage({
      prompt: 'edit with reference',
      files: [{
        id: 'ref-1',
        name: 'reference.png',
        dataUrl: 'data:image/png;base64,aW1hZ2U=',
        mimeType: 'image/png',
      }],
      outputSize: '1K',
      aspectRatio: '1:1',
      temperature: 1,
      model: 'grok-image-2-config',
      gptImageQuality: 'auto',
      gptImageStyle: 'natural',
      gptImageBackground: 'opaque',
      parallelCount: 1,
      grokImageUseUrl: true,
    }, actions, vi.fn());

    expect(mockedCreateNovaTask).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 'grok',
      mode: 'image-to-image',
      model: 'grok-imagine-image-2.0',
      grokImageUseUrl: true,
    }));
  });
});

describe('finalizeCompletedServerTask', () => {
  it('将后端 URL 图片保存为本地历史记录', async () => {
    const job = makeJob();
    const { actions, getJob } = createActions(job);

    await finalizeCompletedServerTask(job, makeCompletedTask(['URL:/api/nova/images/task-1/0']), actions);

    expect(mockedDownloadAndStoreImages).toHaveBeenCalledWith(job.id, ['URL:/api/nova/images/task-1/0']);
    expect(actions.completeJob).toHaveBeenCalledTimes(1);
    expect(getJob().images).toEqual(['IDB:job-1-0']);
  });

  it('本地保存失败时保留原始引用并写入告警', async () => {
    const job = makeJob();
    const { actions, getJob } = createActions(job);
    mockedDownloadAndStoreImages.mockResolvedValue({
      successCount: 1,
      failCount: 1,
      blobUrls: ['blob:cached-0', ''],
      items: [
        { index: 0, status: 'cached', loadedBytes: 1 },
        { index: 1, status: 'failed', loadedBytes: 0, error: 'HTTP 502' },
      ],
    });

    await finalizeCompletedServerTask(job, makeCompletedTask([
      'URL:/api/nova/images/task-1/0',
      'URL:/api/nova/images/task-1/1',
    ]), actions);

    expect(getJob().images).toEqual([
      'IDB:job-1-0',
      'URL:/api/nova/images/task-1/1',
    ]);
    expect(getJob().warning).toContain('1 张图片未能保存至本地');
  });
});

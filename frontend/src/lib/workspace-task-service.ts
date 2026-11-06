import {
  createNovaTask,
  resolveImageTaskProvider,
  type NovaTaskResponse,
  type ImageReference,
} from '@/lib/ccode-task-client';
import type { AspectRatio, OutputSize, StoredJob } from '@/lib/job-store';
import {
  getGptImageAdvancedParamsForModel,
  supportsGptImage26,
  type GptImageBackground,
  type GptImageComplexity,
  type GptImageMarkup,
  type GptImageOutputFormat,
  type GptImageQuality,
  type GptImageStyle,
  type ParallelCount,
} from '@/lib/model-capabilities';
import { downloadAndStoreImages, makeStoredBlobRef } from '@/lib/image-downloader';
import { generateUUID } from '@/lib/uuid';

export interface TextToImageSubmitInput {
  prompts: string[];
  outputSize: OutputSize;
  customSize?: string;
  aspectRatio: AspectRatio;
  temperature: number;
  model: string;
  gptImageQuality: GptImageQuality;
  gptImageStyle: GptImageStyle;
  gptImageBackground: GptImageBackground;
  gptImageComplexity?: GptImageComplexity;
  gptImageOutputFormat?: GptImageOutputFormat;
  gptImageFrameCount?: number;
  gptImageFrameDurationMs?: number;
  parallelCount: ParallelCount;
  grokImageUseUrl?: boolean;
}

export interface ImageToImageSubmitInput {
  prompt: string;
  files: { id: string; name: string; dataUrl: string; mimeType: string }[];
  outputSize: OutputSize;
  customSize?: string;
  aspectRatio: AspectRatio;
  temperature: number;
  model: string;
  gptImageQuality: GptImageQuality;
  gptImageStyle: GptImageStyle;
  gptImageBackground: GptImageBackground;
  gptImageComplexity?: GptImageComplexity;
  gptImageOutputFormat?: GptImageOutputFormat;
  gptImageFrameCount?: number;
  gptImageFrameDurationMs?: number;
  gptImageMarkup?: GptImageMarkup;
  parallelCount: ParallelCount;
  grokImageUseUrl?: boolean;
}

export interface SubmitActions {
  addJob: (job: StoredJob) => void;
  replaceJob: (jobId: string, updater: (job: StoredJob) => StoredJob) => void;
  completeJob: (jobId: string, job: StoredJob) => Promise<void>;
  failJob: (jobId: string, error: string, options?: { terminal?: boolean }) => Promise<void>;
  /** 可选：返回最新 job 快照，供异步流程避免使用过期闭包。 */
  getJob?: (jobId: string) => StoredJob | undefined;
}

function buildImageReferences(files: ImageToImageSubmitInput['files']): ImageReference[] {
  return files.map(file => ({
    data: file.dataUrl.split(',')[1] || file.dataUrl,
    mimeType: file.mimeType,
  }));
}

function createBaseJob(
  mode: StoredJob['mode'],
  prompt: string,
  input: TextToImageSubmitInput | ImageToImageSubmitInput,
  refImages?: StoredJob['refImages']
): StoredJob {
  const advancedParams = getGptImageAdvancedParamsForModel(input.model, {
    quality: input.gptImageQuality,
    style: input.gptImageStyle,
    background: input.gptImageBackground,
    complexity: input.gptImageComplexity,
    outputFormat: input.gptImageOutputFormat,
    frameCount: input.gptImageFrameCount,
    frameDurationMs: input.gptImageFrameDurationMs,
  });
  const isGif = advancedParams.outputFormat === 'gif';

  return {
    id: generateUUID(),
    status: 'processing',
    mode,
    prompt,
    originalPrompt: prompt,
    output_size: isGif ? 'auto' : input.outputSize,
    custom_size: isGif ? undefined : input.customSize,
    temperature: input.temperature,
    aspect_ratio: isGif ? 'auto' : input.aspectRatio,
    model: input.model,
    gptImageQuality: advancedParams.quality,
    gptImageStyle: advancedParams.style,
    gptImageBackground: advancedParams.background,
    ...(supportsGptImage26(input.model) ? {
      gptImageComplexity: advancedParams.complexity,
      gptImageOutputFormat: advancedParams.outputFormat,
      gptImageFrameCount: advancedParams.frameCount,
      gptImageFrameDurationMs: advancedParams.frameDurationMs,
      ...(mode === 'image-to-image' && 'gptImageMarkup' in input ? { gptImageMarkup: input.gptImageMarkup } : {}),
    } : {}),
    parallelCount: input.parallelCount,
    created_at: new Date().toISOString(),
    refImages,
  };
}

export function buildCompletedJobFromTask(job: StoredJob, task: NovaTaskResponse): StoredJob {
  const images = task.result?.images || [];
  if (task.status === 'completed' && images.length > 0) {
    return {
      ...job,
      status: 'completed',
      images,
      imageData: images[0],
      warning: task.warning,
    };
  }

  return {
    ...job,
    status: 'failed',
    error: task.error || (task.status === 'expired' ? '该任务已超出取回时间' : '后端任务失败'),
  };
}

export async function finalizeCompletedServerTask(
  job: StoredJob,
  task: NovaTaskResponse,
  actions: SubmitActions
): Promise<void> {
  const images = task.result?.images || [];

  if (task.status === 'completed' && images.length > 0) {
    const downloadResult = await downloadAndStoreImages(job.id, images);
    const uncachedCount = images.filter((image, index) => (
      image.startsWith('URL:') && downloadResult.items[index]?.status !== 'cached'
    )).length;
    const persistedImages = images.map((image, index) => (
      image.startsWith('URL:') && downloadResult.items[index]?.status === 'cached'
        ? makeStoredBlobRef(job.id, index)
        : image
    ));
    const warning = [
      task.warning,
      uncachedCount > 0 ? `${uncachedCount} 张图片未能保存至本地，原始地址失效后将无法查看` : undefined,
    ].filter((message): message is string => !!message).join('；') || undefined;
    const finalJob: StoredJob = {
      ...job,
      status: 'completed',
      images: persistedImages,
      imageData: persistedImages[0],
      warning,
    };
    await actions.completeJob(job.id, finalJob);
    return;
  }

  const finalJob: StoredJob = {
    ...job,
    status: 'failed',
    error: task.error || (task.status === 'expired' ? '该任务已超出取回时间' : '后端任务失败'),
  };
  await actions.failJob(job.id, finalJob.error || '任务失败');
}

export async function submitTextToImage(
  input: TextToImageSubmitInput,
  actions: SubmitActions,
  onError: (message: string) => void
): Promise<void> {
  const provider = resolveImageTaskProvider(input.model);
  const apiKey = provider.apiKey;

  if (!apiKey) {
    onError('请先配置 API 密钥');
    return;
  }

  for (const prompt of input.prompts) {
    const job = createBaseJob('text-to-image', prompt, input);
    actions.addJob(job);

    try {
      const serverTaskId = await createNovaTask({
        apiKey,
        baseUrl: provider.baseUrl,
        protocol: provider.protocol,
        mode: 'text-to-image',
        prompt,
        outputSize: job.output_size,
        customSize: job.custom_size,
        aspectRatio: job.aspect_ratio,
        temperature: input.temperature,
        model: provider.modelId,
        gptImageQuality: job.gptImageQuality,
        gptImageStyle: job.gptImageStyle,
        gptImageBackground: job.gptImageBackground,
        ...(supportsGptImage26(input.model) ? {
          gptImageComplexity: job.gptImageComplexity,
          gptImageOutputFormat: job.gptImageOutputFormat,
          gptImageFrameCount: job.gptImageFrameCount,
          gptImageFrameDurationMs: job.gptImageFrameDurationMs,
        } : {}),
        parallelCount: input.parallelCount,
        grokImageUseUrl: input.grokImageUseUrl === true,
        images: [],
      });

      actions.replaceJob(job.id, current => ({
        ...current,
        status: '排队中',
        serverTaskId,
      }));
    } catch (error) {
      await actions.failJob(job.id, error instanceof Error ? error.message : String(error));
    }
  }
}

export async function submitImageToImage(
  input: ImageToImageSubmitInput,
  actions: SubmitActions,
  onError: (message: string) => void
): Promise<void> {
  if (input.gptImageOutputFormat === 'svg') {
    onError('SVG 输出仅支持文生图，请切换为 PNG、JPEG、WebP 或 GIF 后编辑图片');
    return;
  }
  const provider = resolveImageTaskProvider(input.model);
  const apiKey = provider.apiKey;

  if (!apiKey) {
    onError('请先配置 API 密钥');
    return;
  }

  const refImages = input.files.map(file => ({
    id: file.id,
    name: file.name,
    dataUrl: file.dataUrl,
    mimeType: file.mimeType,
  }));
  const imageReferences = buildImageReferences(input.files);
  const job = createBaseJob('image-to-image', input.prompt, input, refImages);

  actions.addJob(job);

  try {
    const serverTaskId = await createNovaTask({
      apiKey,
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      mode: 'image-to-image',
      prompt: input.prompt,
      outputSize: job.output_size,
      customSize: job.custom_size,
      aspectRatio: job.aspect_ratio,
      temperature: input.temperature,
      model: provider.modelId,
      gptImageQuality: job.gptImageQuality,
      gptImageStyle: job.gptImageStyle,
      gptImageBackground: job.gptImageBackground,
      ...(supportsGptImage26(input.model) ? {
        gptImageComplexity: job.gptImageComplexity,
        gptImageOutputFormat: job.gptImageOutputFormat,
        gptImageFrameCount: job.gptImageFrameCount,
        gptImageFrameDurationMs: job.gptImageFrameDurationMs,
        gptImageMarkup: job.gptImageMarkup,
      } : {}),
      parallelCount: input.parallelCount,
      grokImageUseUrl: input.grokImageUseUrl === true,
      images: imageReferences,
    });

    actions.replaceJob(job.id, current => ({
      ...current,
      status: '排队中',
      serverTaskId,
    }));
  } catch (error) {
    await actions.failJob(job.id, error instanceof Error ? error.message : String(error));
  }
}

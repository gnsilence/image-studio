import {
  createNovaTask,
  resolveImageTaskProvider,
  type NovaTaskResponse,
  type ImageReference,
} from '@/lib/ccode-task-client';
import type { ModelId } from '@/lib/gemini-config';
import type { AspectRatio, OutputSize, StoredJob } from '@/lib/job-store';
import {
  getGptImageAdvancedParamsForModel,
  type GptImageBackground,
  type GptImageQuality,
  type GptImageStyle,
  type ParallelCount,
} from '@/lib/model-capabilities';
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
  parallelCount: ParallelCount;
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
  parallelCount: ParallelCount;
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
  outputSize: OutputSize,
  customSize: string | undefined,
  aspectRatio: AspectRatio,
  temperature: number,
  model: string,
  gptImageQuality: GptImageQuality,
  gptImageStyle: GptImageStyle,
  gptImageBackground: GptImageBackground,
  parallelCount: ParallelCount,
  refImages?: StoredJob['refImages']
): StoredJob {
  const advancedParams = getGptImageAdvancedParamsForModel(model as ModelId, {
    quality: gptImageQuality,
    style: gptImageStyle,
    background: gptImageBackground,
  });

  return {
    id: generateUUID(),
    status: 'processing',
    mode,
    prompt,
    originalPrompt: prompt,
    output_size: outputSize,
    custom_size: customSize,
    temperature,
    aspect_ratio: aspectRatio,
    model,
    gptImageQuality: advancedParams.quality,
    gptImageStyle: advancedParams.style,
    gptImageBackground: advancedParams.background,
    parallelCount,
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
    const finalJob: StoredJob = {
      ...job,
      status: 'completed',
      images,
      imageData: images[0],
      warning: task.warning,
      blobUrls: undefined,
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
    const job = createBaseJob(
      'text-to-image',
      prompt,
      input.outputSize,
      input.customSize,
      input.aspectRatio,
      input.temperature,
      input.model,
      input.gptImageQuality,
      input.gptImageStyle,
      input.gptImageBackground,
      input.parallelCount
    );
    actions.addJob(job);

    try {
      const serverTaskId = await createNovaTask({
        apiKey,
        baseUrl: provider.baseUrl,
        protocol: provider.protocol,
        mode: 'text-to-image',
        prompt,
        outputSize: input.outputSize,
        customSize: input.customSize,
        aspectRatio: input.aspectRatio,
        temperature: input.temperature,
        model: provider.modelId,
        gptImageQuality: input.gptImageQuality,
        gptImageStyle: input.gptImageStyle,
        gptImageBackground: input.gptImageBackground,
        parallelCount: input.parallelCount,
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
  const job = createBaseJob(
    'image-to-image',
    input.prompt,
    input.outputSize,
    input.customSize,
    input.aspectRatio,
    input.temperature,
    input.model,
    input.gptImageQuality,
    input.gptImageStyle,
    input.gptImageBackground,
    input.parallelCount,
    refImages
  );

  actions.addJob(job);

  try {
    const serverTaskId = await createNovaTask({
      apiKey,
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      mode: 'image-to-image',
      prompt: input.prompt,
      outputSize: input.outputSize,
      customSize: input.customSize,
      aspectRatio: input.aspectRatio,
      temperature: input.temperature,
      model: provider.modelId,
      gptImageQuality: input.gptImageQuality,
      gptImageStyle: input.gptImageStyle,
      gptImageBackground: input.gptImageBackground,
      parallelCount: input.parallelCount,
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

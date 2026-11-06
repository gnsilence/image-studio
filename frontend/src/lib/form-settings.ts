/**
 * 文本生图 / 图生图 共享的表单设置类型
 * 两个表单（TextToImageForm、ImageToImageForm）的设置字段完全一致，
 * 统一定义于此避免重复。
 */

import type { ModelId } from '@/lib/gemini-config';
import type { OutputSize, AspectRatio } from '@/lib/job-store';
import type { GptImageBackground, GptImageComplexity, GptImageOutputFormat, GptImageQuality, GptImageStyle, ParallelCount } from '@/lib/model-capabilities';

export const IMAGE_GENERATION_WORKBENCH_SETTINGS_KEY = 'nova-image-generation-settings';

export interface ImageFormSettings {
  model: ModelId;
  outputSize: OutputSize;
  customSize?: string;
  aspectRatio: AspectRatio;
  temperature: number;
  gptImageQuality: GptImageQuality;
  gptImageStyle: GptImageStyle;
  gptImageBackground: GptImageBackground;
  gptImageComplexity?: GptImageComplexity;
  gptImageOutputFormat?: GptImageOutputFormat;
  gptImageFrameCount?: number;
  gptImageFrameDurationMs?: number;
  parallelCount: ParallelCount;
  grokImageUseUrl?: boolean;
  keepPromptAfterSubmit?: boolean;
}

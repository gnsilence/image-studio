import { beforeEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_IMAGE_PRESET_OPTIONS,
  BUILTIN_IMAGE_PRESETS,
  FIXED_MODEL_BASE_URL,
  getImageModelOutputSizes,
  loadRegistry,
  saveRegistry,
  type NovaModelRegistry,
} from '@/lib/nova-models';
import {
  getAspectRatioOptions,
  getCompatibleRetryData,
  getGptImageAdvancedParamsForModel,
  getGptImageQualityOptions,
  getModelMaxRefImages,
  getParallelCountOptions,
  getSupportsTemperature,
  getValidOutputSizes,
  isRetryLayoutCompatible,
  supportsAutoLayout,
  supportsGptImageAdvancedParams,
  supportsGptImage26,
  normalizeParallelCount,
  resolveAgentLayout,
} from '@/lib/model-capabilities';
import type { StoredJob } from '@/lib/job-store';

const registry: NovaModelRegistry = {
  imageModels: [{
    id: 'image-model',
    protocol: 'openai',
    name: 'Image Model',
    modelId: 'gpt-image-2',
    apiKey: 'image-key',
    baseUrl: 'https://old.example.com',
    builtinPreset: 'gpt-image-2',
    maxRefImages: 16,
    maxOutputSize: '4K',
    supportsAdvancedParams: true,
  }],
  textModels: [{
    id: 'text-model',
    protocol: 'openai-responses',
    name: 'Text Model',
    modelId: 'gpt-5.4-mini',
    apiKey: 'text-key',
    baseUrl: 'https://old.example.com/v1',
  }],
  defaults: {
    textToImage: 'image-model',
    imageToImage: 'image-model',
    reversePrompt: 'text-model',
    agent: 'text-model',
    promptOptimize: 'text-model',
    imageDescribe: 'text-model',
  },
};

beforeEach(() => {
  localStorage.clear();
});

describe('Nova model Base URL', () => {
  it('offers both GPT Image 2.6 presets and limits new controls to compatible models', () => {
    for (const presetId of ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'] as const) {
      expect(BUILTIN_IMAGE_PRESETS[presetId]).toMatchObject({
        protocol: 'openai', modelId: presetId, maxRefImages: 16, maxOutputSize: '4K',
      });
      expect(supportsGptImage26(presetId)).toBe(true);
      expect(getGptImageAdvancedParamsForModel(presetId, {})).toMatchObject({
        complexity: 'high', outputFormat: 'png', frameCount: 9, frameDurationMs: 200,
      });
    }
    expect(getGptImageQualityOptions('gpt-image-2').map(option => option.value)).not.toContain('max');
    expect(getGptImageQualityOptions('gpt-image-2.5-sunburst').map(option => option.value)).toContain('max');
    expect(getGptImageAdvancedParamsForModel('gpt-image-2', {
      quality: 'xhigh', outputFormat: 'gif', complexity: 'low', frameCount: 16,
    })).toEqual({ quality: 'auto', style: 'auto', background: 'auto' });
    expect(getGptImageAdvancedParamsForModel('gpt-image-2.5-flare', { quality: 'xhigh' }).quality).toBe('xhigh');
  });

  it('normalizes native GIF timing and preserves its output settings when retrying', () => {
    const next = structuredClone(registry);
    next.imageModels[0] = {
      ...next.imageModels[0], modelId: 'gpt-image-2.6-flare', builtinPreset: 'gpt-image-2.6-flare',
    };
    saveRegistry(next);
    expect(getGptImageAdvancedParamsForModel('image-model', { frameCount: 99, frameDurationMs: 1 })).toMatchObject({
      frameCount: 16, frameDurationMs: 20,
    });
    const job: StoredJob = {
      id: 'native-gif', status: 'completed', mode: 'text-to-image', prompt: 'loop', model: 'image-model',
      output_size: '4K', custom_size: '4096x4096', aspect_ratio: '1:1', temperature: 1,
      gptImageOutputFormat: 'gif', gptImageComplexity: 'medium', gptImageFrameCount: 12,
      gptImageFrameDurationMs: 100, gptImageQuality: 'max', created_at: '2026-11-05T00:00:00.000Z',
    };
    expect(getCompatibleRetryData(job)).toMatchObject({
      outputSize: 'auto', aspectRatio: 'auto', customSize: undefined,
      gptImageOutputFormat: 'gif', gptImageComplexity: 'medium', gptImageFrameCount: 12,
      gptImageFrameDurationMs: 100, gptImageQuality: 'max',
    });
    const markup = { data: 'AA==', mimeType: 'image/png' as const };
    expect(getCompatibleRetryData({ ...job, mode: 'image-to-image', gptImageOutputFormat: 'png', gptImageMarkup: markup }))
      .toMatchObject({ gptImageMarkup: markup, gptImageOutputFormat: 'png' });
    saveRegistry(registry);
    expect(getCompatibleRetryData({ ...job, gptImageMarkup: markup })).not.toHaveProperty('gptImageOutputFormat');
  });

  it.each(['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'] as const)(
    'restores reference-guided GIF history for %s while excluding SVG edits',
    presetId => {
      const next = structuredClone(registry);
      next.imageModels[0] = {
        ...next.imageModels[0], modelId: presetId, builtinPreset: presetId,
      };
      saveRegistry(next);
      const refImages = [{
        id: 'ref-1', name: 'reference.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==',
      }];
      const job: StoredJob = {
        id: 'reference-gif', status: 'completed', mode: 'image-to-image', prompt: 'animate this reference',
        model: 'image-model', output_size: '4K', custom_size: '3840x2160', aspect_ratio: '16:9', temperature: 1,
        gptImageOutputFormat: 'gif', gptImageComplexity: 'medium', gptImageFrameCount: 12,
        gptImageFrameDurationMs: 120, gptImageQuality: 'max', refImages, created_at: '2026-11-06T00:00:00.000Z',
      };

      expect(getCompatibleRetryData(job)).toMatchObject({
        mode: 'image-to-image', model: 'image-model', outputSize: 'auto', customSize: undefined, aspectRatio: 'auto',
        gptImageOutputFormat: 'gif', gptImageComplexity: 'medium', gptImageFrameCount: 12,
        gptImageFrameDurationMs: 120, gptImageQuality: 'max', refImages,
      });
      expect(getCompatibleRetryData({ ...job, gptImageOutputFormat: 'svg' }).gptImageOutputFormat).toBe('png');
    },
  );

  function configureGrok2() {
    const next = structuredClone(registry);
    const preset = BUILTIN_IMAGE_PRESETS['grok-imagine-image-2.0'];
    next.imageModels[0] = {
      ...next.imageModels[0],
      ...preset,
      id: 'image-model',
      builtinPreset: preset.id,
    };
    saveRegistry(next);
    return loadRegistry().imageModels[0];
  }

  it('offers and persists the Grok Imagine 2.0 preset with editing and quality controls', () => {
    expect(BUILTIN_IMAGE_PRESET_OPTIONS).toContainEqual({
      value: 'grok-imagine-image-2.0',
      label: 'Grok Imagine 2.0',
    });
    expect(configureGrok2()).toMatchObject({
      protocol: 'grok',
      modelId: 'grok-imagine-image-2.0',
      maxRefImages: 5,
      maxOutputSize: '2K',
      supportsAdvancedParams: true,
    });
    expect(getModelMaxRefImages('image-model')).toBe(5);
    expect(supportsGptImageAdvancedParams('image-model')).toBe(true);
    expect(getSupportsTemperature('image-model')).toBe(false);
  });

  it('offers the official Grok 2.0 resolutions and respects a configured lower maximum', () => {
    const model = configureGrok2();
    expect(getValidOutputSizes('image-model')).toEqual(['1K', '1.5K', '2K']);
    expect(getImageModelOutputSizes(model)).toEqual(['1K', '1.5K', '2K']);
    expect(getImageModelOutputSizes({ ...model, maxOutputSize: '1.5K' })).toEqual(['1K', '1.5K']);
    expect(getImageModelOutputSizes({ ...model, maxOutputSize: '1K' })).toEqual(['1K']);
    const next = loadRegistry();
    next.imageModels[0].maxOutputSize = '1.5K';
    next.imageModels[0].maxRefImages = 10;
    saveRegistry(next);
    expect(getValidOutputSizes('image-model')).toEqual(['1K', '1.5K']);
    expect(getModelMaxRefImages('image-model')).toBe(5);
  });

  it('offers exactly the documented Grok 2.0 ratios and preserves auto ratio on retry', () => {
    configureGrok2();
    expect(getAspectRatioOptions('image-model', '1.5K').map(option => option.value)).toEqual([
      'auto', '1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9',
      '9:19.5', '19.5:9', '9:20', '20:9', '1:2', '2:1', '21:9', '5:2',
    ]);
    expect(isRetryLayoutCompatible('image-model', '1.5K', 'auto')).toBe(true);
    expect(isRetryLayoutCompatible('image-model', '2K', '19.5:9')).toBe(true);
    expect(isRetryLayoutCompatible('image-model', '4K', '16:9')).toBe(false);
    expect(isRetryLayoutCompatible('image-model', '2K', '4:5')).toBe(false);
    expect(supportsAutoLayout('image-model')).toBe(false);
  });

  it('keeps only supported Grok 2.0 quality parameters when switching from GPT Image', () => {
    configureGrok2();
    expect(getGptImageAdvancedParamsForModel('image-model', {
      quality: 'low', style: 'vivid', background: 'transparent',
    })).toEqual({ quality: 'low', style: 'auto', background: 'auto' });
    expect(getGptImageAdvancedParamsForModel('image-model', { quality: 'medium' }).quality).toBe('medium');
    expect(getGptImageAdvancedParamsForModel('image-model', { quality: 'high' }).quality).toBe('auto');
  });

  it('supports ten Grok 2.0 outputs while preserving other model count limits', () => {
    configureGrok2();
    expect(getParallelCountOptions('image-model')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(normalizeParallelCount(10, 'image-model')).toBe(10);
    expect(normalizeParallelCount(11, 'image-model')).toBe(10);
    expect(normalizeParallelCount(10, 'gpt-image-2')).toBe(4);
    expect(getParallelCountOptions('grok-imagine-image-edit')).toEqual([1, 2, 3, 4]);
  });

  it('retains Grok 2.0 references, quality, resolution and batch size in history retry', () => {
    configureGrok2();
    const refImages = Array.from({ length: 5 }, (_, index) => ({
      id: `ref-${index}`, name: `ref-${index}.png`, mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==',
    }));
    const job: StoredJob = {
      id: 'grok-job', status: 'completed', mode: 'image-to-image', prompt: 'combine references',
      output_size: '1.5K', aspect_ratio: 'auto', model: 'image-model', temperature: 1,
      gptImageQuality: 'medium', parallelCount: 10, refImages, created_at: '2026-10-19T00:00:00.000Z',
    };
    expect(getCompatibleRetryData(job)).toMatchObject({
      outputSize: '1.5K', aspectRatio: 'auto', gptImageQuality: 'medium', parallelCount: 10, refImages,
    });
    expect(resolveAgentLayout('image-model', {
      requestedOutputSize: '1.5K', requestedAspectRatio: '9:19.5', parallelCount: 10,
    })).toMatchObject({ outputSize: '1.5K', aspectRatio: '9:19.5', parallelCount: 10 });
  });

  it('provides a GPT Image 2.5 preset using the OpenAI image protocol', () => {
    expect(BUILTIN_IMAGE_PRESETS['gpt-image-2.5']).toMatchObject({
      protocol: 'openai',
      name: 'GPT Image 2.5',
      modelId: 'gpt-image-2.5',
      maxRefImages: 16,
      maxOutputSize: '4K',
      supportsAdvancedParams: true,
    });
  });

  it('applies GPT Image capabilities to a configured GPT Image 2.5 model', () => {
    const next = structuredClone(registry);
    next.imageModels[0] = {
      ...next.imageModels[0],
      modelId: 'gpt-image-2.5',
      builtinPreset: 'gpt-image-2.5',
    };
    saveRegistry(next);

    expect(getValidOutputSizes('image-model')).toEqual(['auto', '1K', '2K', '4K']);
    expect(getAspectRatioOptions('image-model', '4K')).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: '16:9', resolution: '3840x2160' }),
      expect.objectContaining({ value: '9:16', resolution: '2160x3840' }),
    ]));
    expect(supportsAutoLayout('image-model')).toBe(true);
    expect(supportsGptImageAdvancedParams('image-model')).toBe(true);
    expect(isRetryLayoutCompatible('image-model', '4K', '16:9')).toBe(true);
  });

  it('offers GPT Image 2.5 Flare and Sunburst presets in the image preset picker', () => {
    expect(BUILTIN_IMAGE_PRESETS['gpt-image-2.5-flare']).toMatchObject({
      protocol: 'openai',
      name: 'GPT Image 2.5 Flare',
      modelId: 'gpt-image-2.5-flare',
      baseUrl: FIXED_MODEL_BASE_URL,
      maxRefImages: 16,
      maxOutputSize: '4K',
      supportsAdvancedParams: true,
    });
    expect(BUILTIN_IMAGE_PRESETS['gpt-image-2.5-sunburst']).toMatchObject({
      protocol: 'openai',
      name: 'GPT Image 2.5 Sunburst',
      modelId: 'gpt-image-2.5-sunburst',
      baseUrl: FIXED_MODEL_BASE_URL,
      maxRefImages: 16,
      maxOutputSize: '4K',
      supportsAdvancedParams: true,
    });
    expect(BUILTIN_IMAGE_PRESET_OPTIONS).toEqual(expect.arrayContaining([
      { value: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare' },
      { value: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst' },
    ]));
  });

  it('keeps the Flare and Sunburst presets and GPT Image capabilities after saving', () => {
    for (const presetId of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'] as const) {
      const next = structuredClone(registry);
      next.imageModels[0] = {
        ...next.imageModels[0],
        modelId: presetId,
        builtinPreset: presetId,
      };
      saveRegistry(next);

      expect(loadRegistry().imageModels[0]).toMatchObject({ builtinPreset: presetId, modelId: presetId });
      expect(getValidOutputSizes('image-model')).toEqual(['auto', '1K', '2K', '4K']);
      expect(supportsGptImageAdvancedParams('image-model')).toBe(true);
    }
  });

  it('keeps image addresses configurable while fixing text addresses', () => {
    localStorage.setItem('nova-model-registry', JSON.stringify(registry));

    const loaded = loadRegistry();

    expect(loaded.imageModels[0].baseUrl).toBe('https://old.example.com');
    expect(loaded.textModels[0].baseUrl).toBe(FIXED_MODEL_BASE_URL);
  });

  it('persists image addresses but never persists a caller-provided text address', () => {
    saveRegistry(registry);

    const persisted = JSON.parse(localStorage.getItem('nova-model-registry') || '{}') as NovaModelRegistry;
    expect(persisted.imageModels[0].baseUrl).toBe('https://old.example.com');
    expect(persisted.textModels[0].baseUrl).toBe(FIXED_MODEL_BASE_URL);
  });

  it('uses the fixed address for legacy image models without a Base URL', () => {
    const legacy = structuredClone(registry);
    legacy.imageModels[0].baseUrl = '';
    localStorage.setItem('nova-model-registry', JSON.stringify(legacy));

    expect(loadRegistry().imageModels[0].baseUrl).toBe(FIXED_MODEL_BASE_URL);
  });
});

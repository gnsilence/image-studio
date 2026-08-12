import { beforeEach, describe, expect, it } from 'vitest';
import {
  FIXED_MODEL_BASE_URL,
  loadRegistry,
  saveRegistry,
  type NovaModelRegistry,
} from '@/lib/nova-models';

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

import { describe, expect, it } from 'vitest';
import {
  buildGeminiStreamGenerateContentUrl,
  buildResponsesApiUrl,
  normalizeModelBaseUrl,
  normalizeTextModelBaseUrl,
} from '@/lib/model-endpoints';
import { FIXED_MODEL_BASE_URL } from '@/lib/nova-models';

describe('model Base URL routing', () => {
  it('normalizes caller-provided image model addresses', () => {
    expect(normalizeModelBaseUrl('openai', 'https://images.example.com/v1/')).toBe('https://images.example.com');
    expect(normalizeModelBaseUrl('grok', 'https://images.example.com/')).toBe('https://images.example.com');
    expect(normalizeModelBaseUrl('google', 'https://images.example.com/v1beta/')).toBe('https://images.example.com');
  });

  it('ignores caller-provided text model addresses', () => {
    expect(normalizeTextModelBaseUrl('openai-responses', 'https://other.example.com')).toBe(FIXED_MODEL_BASE_URL);
    expect(buildResponsesApiUrl('https://other.example.com')).toBe(`${FIXED_MODEL_BASE_URL}/v1/responses`);
    expect(buildGeminiStreamGenerateContentUrl('https://other.example.com', 'gemini-test'))
      .toBe(`${FIXED_MODEL_BASE_URL}/v1beta/models/gemini-test:streamGenerateContent?alt=sse`);
  });
});

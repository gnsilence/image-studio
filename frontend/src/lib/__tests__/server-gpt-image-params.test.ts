import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverSource = fs.readFileSync(
  path.resolve(testDir, '../../../../backend/server.js'),
  'utf8',
);

describe('backend GPT Image advanced params forwarding', () => {
  it('does not contain legacy GPT Image SKU gating or token suffix logic', () => {
    expect(serverSource).not.toMatch(/['"]gpt-image-2-(?:fast|plus|pro)['"]/);
    expect(serverSource).not.toContain('TOKEN_SUFFIX');
    expect(serverSource).not.toContain('supportsGptImageAdvancedParams(');
  });

  it('forwards quality/background/output_format and conditional style in multipart edits', () => {
    expect(serverSource).toContain("formData.append('quality', advancedParams.quality)");
    expect(serverSource).toContain("formData.append('background', advancedParams.background)");
    expect(serverSource).toContain("formData.append('output_format', 'png')");
    expect(serverSource).toContain("formData.append('style', advancedParams.style)");
  });

  it('forwards quality/background/output_format and conditional style in JSON generations', () => {
    expect(serverSource).toContain('quality: advancedParams.quality');
    expect(serverSource).toContain('background: advancedParams.background');
    expect(serverSource).toContain("output_format: 'png'");
    expect(serverSource).toContain("advancedParams.style === 'vivid' || advancedParams.style === 'natural' ? { style: advancedParams.style } : {}");
  });

  it('routes OpenAI image endpoint by mode rather than legacy model names', () => {
    expect(serverSource).toContain("request.mode === 'image-to-image'");
    expect(serverSource).toContain("/v1/images/edits");
    expect(serverSource).toContain("/v1/images/generations");
  });

  it('resolves and forwards size for OpenAI image requests', () => {
    expect(serverSource).toContain('function resolveGptImageRequestSize(request)');
    expect(serverSource).toContain('const customSize = normalizeCustomImageSize(request.customSize, 4096)');
    expect(serverSource).toContain('return getSupportedGptImageSize(request.model, request.outputSize, request.aspectRatio)');
    expect(serverSource).toContain('const resolvedSize = resolveGptImageRequestSize(request)');
    expect(serverSource).toContain('return requestGptImage(apiKey, request, resolvedSize, { baseUrl, trace });');
  });

  it('tries OpenAI image streaming with partial image support before falling back', () => {
    expect(serverSource).toContain("const IMAGE_STREAM_ENABLED = String(process.env.NOVA_IMAGE_STREAM ?? 'true').toLowerCase() !== 'false'");
    expect(serverSource).toContain('const IMAGE_STREAM_PARTIAL_IMAGES = Math.min(3, Math.max(0, Number.parseInt(process.env.NOVA_IMAGE_PARTIAL_IMAGES');
    expect(serverSource).toContain("formData.append('partial_images', String(partialImages))");
    expect(serverSource).toContain('partial_images: partialImages');
    expect(serverSource).toContain('if (!isImageStreamUnsupportedError(error)) throw error');
    expect(serverSource).toContain("console.warn('[image-stream] 上游不支持图片流式参数，回退非流式请求')");
  });

  it('allows configuring task TTL hours', () => {
    expect(serverSource).toContain('const TASK_TTL_MS = (Number(process.env.NOVA_TASK_TTL_HOURS) || 12) * 60 * 60 * 1000');
  });

  it('uses configurable image addresses while keeping text requests fixed', () => {
    expect(serverSource).toContain("const FIXED_MODEL_BASE_URL = 'https://www.aioss.cc';");
    expect(serverSource).toContain('body.baseUrl = normalizeProtocolBaseUrl(body.protocol, body.baseUrl);');
    expect(serverSource).toContain('const normalizedBaseUrl = FIXED_MODEL_BASE_URL;');
    expect(serverSource).toContain("const normalizedBaseUrl = modelType === 'image'");
    expect(serverSource).toContain("? normalizeProtocolBaseUrl(protocol, parsed.searchParams.get('baseUrl'))");
  });
});

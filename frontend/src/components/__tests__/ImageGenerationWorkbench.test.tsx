import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ImageGenerationWorkbench } from '@/components/ImageGenerationWorkbench';
import { BUILTIN_IMAGE_PRESETS, DEFAULT_DEFAULTS } from '@/lib/nova-models';
import { IMAGE_GENERATION_WORKBENCH_SETTINGS_KEY } from '@/lib/form-settings';

vi.mock('@/components/MissingApiKeyDialog', () => ({ MissingApiKeyDialog: () => null }));
vi.mock('@/components/QuickPromptDialog', () => ({ QuickPromptDialog: () => null }));
vi.mock('@/components/PromptOptimizeDialog', () => ({ PromptOptimizeDialog: () => null }));
vi.mock('@/components/agent/AgentAssetPickerDialog', () => ({
  AgentAssetPickerDialog: () => null,
  AgentTextAssetPickerDialog: () => null,
}));
vi.mock('@/components/canvas/components/image-annotation-editor', () => ({ ImageAnnotationEditor: () => null }));
vi.mock('@/components/AttachmentChips', () => ({
  AttachmentChips: ({ files, onRemove }: { files: { id: string; name: string }[]; onRemove: (id: string) => void }) => (
    <div>{files.map(file => <button key={file.id} type="button" onClick={() => onRemove(file.id)}>移除 {file.name}</button>)}</div>
  ),
}));

const firstReference = { id: 'ref-1', name: 'first.png', dataUrl: 'data:image/png;base64,AA==', mimeType: 'image/png' };
const secondReference = { id: 'ref-2', name: 'second.png', dataUrl: 'data:image/png;base64,AQ==', mimeType: 'image/png' };
const markup = { data: 'bWFya3Vw', mimeType: 'image/png' as const };

function readSettings() {
  return JSON.parse(localStorage.getItem(IMAGE_GENERATION_WORKBENCH_SETTINGS_KEY) || '{}');
}

beforeEach(() => {
  localStorage.clear();
  const imageModels = [
    BUILTIN_IMAGE_PRESETS['gpt-image-2.6-sunburst'],
    BUILTIN_IMAGE_PRESETS['gpt-image-2.6-flare'],
    BUILTIN_IMAGE_PRESETS['gpt-image-2'],
  ].map(preset => ({ ...preset, apiKey: 'test-key', builtinPreset: preset.id }));
  localStorage.setItem('nova-model-registry', JSON.stringify({
    imageModels, textModels: [], defaults: { ...DEFAULT_DEFAULTS, textToImage: imageModels[0].id, imageToImage: imageModels[0].id },
  }));
});

describe('ImageGenerationWorkbench GPT Image 2.6', () => {
  it.each([false, true])('restores native GIF settings with references=%s and uses automatic size on submit', async withReferences => {
    const onSubmitText = vi.fn();
    const onSubmitImage = vi.fn();
    render(<ImageGenerationWorkbench onSubmitText={onSubmitText} onSubmitImage={onSubmitImage} initialData={{
      model: 'gpt-image-2.6-flare', prompt: 'looping flower', outputSize: '4K', customSize: '4096x4096', aspectRatio: '1:1',
      gptImageQuality: 'max', gptImageComplexity: 'medium', gptImageOutputFormat: 'gif',
      gptImageFrameCount: 12, gptImageFrameDurationMs: 100,
      ...(withReferences ? { refImages: [firstReference] } : {}),
    }} />);
    await screen.findByText(/GIF 帧尺寸由模型自动选择/);
    expect(screen.getByTitle('自动模式已锁定分辨率')).toBeDisabled();
    expect(screen.getByTitle('自动模式已锁定比例')).toBeDisabled();
    expect(screen.getByTitle('自动分辨率和比例')).toBeDisabled();
    fireEvent.click(screen.getByTitle(withReferences ? '按图生图提交' : '按文生图提交'));
    expect(withReferences ? onSubmitImage : onSubmitText).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-image-2.6-flare', outputSize: 'auto', customSize: undefined,
      aspectRatio: 'auto', gptImageQuality: 'max', gptImageComplexity: 'medium',
      gptImageOutputFormat: 'gif', gptImageFrameCount: 12, gptImageFrameDurationMs: 100,
      ...(withReferences ? { prompt: 'looping flower', files: [expect.objectContaining({ id: 'ref-1' })] } : { prompts: ['looping flower'] }),
    }));
  });

  it('changes complexity, output format and GIF timing through the actual controls', async () => {
    const onSubmitText = vi.fn();
    const view = render(<ImageGenerationWorkbench onSubmitText={onSubmitText} onSubmitImage={vi.fn()} initialData={{
      model: 'gpt-image-2.6-sunburst', prompt: 'a small animation', outputSize: '1K', aspectRatio: '1:1',
    }} />);
    fireEvent.click(await screen.findByTitle('图像参数'));
    const complexityGroup = (await screen.findByText('复杂度', { selector: 'label' })).parentElement!;
    fireEvent.click(within(complexityGroup).getByRole('button', { name: /^低$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^GIF 动画$/ }));
    fireEvent.change(screen.getByLabelText('GIF 帧数'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('GIF 每帧时长'), { target: { value: '300' } });
    fireEvent.click(screen.getByTitle('图像参数'));
    fireEvent.click(screen.getByTitle('按文生图提交'));
    expect(onSubmitText).toHaveBeenCalledWith(expect.objectContaining({
      gptImageComplexity: 'low', gptImageOutputFormat: 'gif', gptImageFrameCount: 8, gptImageFrameDurationMs: 300,
      outputSize: 'auto', aspectRatio: 'auto', customSize: undefined,
    }));
    expect(readSettings()).toMatchObject({ gptImageOutputFormat: 'gif', gptImageComplexity: 'low', gptImageFrameCount: 8, gptImageFrameDurationMs: 300 });
    view.unmount();
    render(<ImageGenerationWorkbench onSubmitText={vi.fn()} onSubmitImage={vi.fn()} />);
    await screen.findByText(/GIF 帧尺寸由模型自动选择/);
    fireEvent.click(screen.getByTitle('图像参数'));
    expect(screen.getByLabelText('GIF 帧数')).toHaveValue(8);
    expect(screen.getByLabelText('GIF 每帧时长')).toHaveValue(300);
  });

  it('switches SVG drafts to PNG when references make the workflow an edit', async () => {
    const onSubmitImage = vi.fn();
    render(<ImageGenerationWorkbench onSubmitText={vi.fn()} onSubmitImage={onSubmitImage} initialData={{
      model: 'gpt-image-2.6-sunburst', prompt: 'edit the flower', gptImageOutputFormat: 'svg', refImages: [firstReference],
    }} />);
    await waitFor(() => expect(readSettings().gptImageOutputFormat).toBe('png'));
    fireEvent.click(screen.getByTitle('按图生图提交'));
    expect(onSubmitImage).toHaveBeenCalledWith(expect.objectContaining({ gptImageOutputFormat: 'png', files: [expect.objectContaining({ id: 'ref-1' })] }));
  });

  it.each(['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare'])('selects GIF after adding references for %s and submits its timing with automatic size', async model => {
    const onSubmitImage = vi.fn();
    render(<ImageGenerationWorkbench onSubmitText={vi.fn()} onSubmitImage={onSubmitImage} initialData={{
      model, prompt: 'animate the flower', outputSize: '4K', customSize: '4096x4096', aspectRatio: '1:1', refImages: [firstReference],
    }} />);
    fireEvent.click(await screen.findByTitle('图像参数'));
    expect(screen.queryByRole('button', { name: /^SVG 矢量图$/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^GIF 动画$/ }));
    fireEvent.change(screen.getByLabelText('GIF 帧数'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('GIF 每帧时长'), { target: { value: '300' } });
    fireEvent.click(screen.getByTitle('图像参数'));
    expect(screen.getByTitle('自动分辨率和比例')).toBeDisabled();
    fireEvent.click(screen.getByTitle('按图生图提交'));
    expect(onSubmitImage).toHaveBeenCalledWith(expect.objectContaining({
      model, files: [expect.objectContaining({ id: 'ref-1' })], gptImageOutputFormat: 'gif',
      gptImageFrameCount: 8, gptImageFrameDurationMs: 300, outputSize: 'auto', customSize: undefined, aspectRatio: 'auto',
    }));
  });

  it('preserves GIF settings when a completed image is added as a reference draft', async () => {
    const onSubmitText = vi.fn();
    const onSubmitImage = vi.fn();
    const initialData = {
      model: 'gpt-image-2.6-flare', prompt: 'animate this image', gptImageOutputFormat: 'gif' as const,
      gptImageFrameCount: 10, gptImageFrameDurationMs: 250,
    };
    const view = render(<ImageGenerationWorkbench onSubmitText={onSubmitText} onSubmitImage={onSubmitImage} initialData={initialData} />);
    await screen.findByText(/GIF 帧尺寸由模型自动选择/);
    view.rerender(<ImageGenerationWorkbench onSubmitText={onSubmitText} onSubmitImage={onSubmitImage} initialData={initialData} referenceDraft={{ id: 1, refImages: [firstReference] }} />);
    await screen.findByTitle('按图生图提交');
    expect(readSettings()).toMatchObject({ gptImageOutputFormat: 'gif', outputSize: 'auto', aspectRatio: 'auto' });
    fireEvent.click(screen.getByTitle('按图生图提交'));
    expect(onSubmitImage).toHaveBeenCalledWith(expect.objectContaining({
      files: [expect.objectContaining({ id: 'ref-1' })], gptImageOutputFormat: 'gif', gptImageFrameCount: 10,
      gptImageFrameDurationMs: 250, outputSize: 'auto', customSize: undefined, aspectRatio: 'auto',
    }));
    expect(onSubmitText).not.toHaveBeenCalled();
  });

  it('restores the separate markup on submit without persisting its bytes in form settings', async () => {
    const onSubmitImage = vi.fn();
    render(<ImageGenerationWorkbench onSubmitText={vi.fn()} onSubmitImage={onSubmitImage} initialData={{
      model: 'gpt-image-2.6-sunburst', prompt: 'move the marked object', refImages: [firstReference], gptImageMarkup: markup,
      gptImageComplexity: 'low', gptImageOutputFormat: 'webp',
    }} />);
    await screen.findByText('已恢复标注层');
    expect(readSettings()).not.toHaveProperty('gptImageMarkup');
    expect(localStorage.getItem(IMAGE_GENERATION_WORKBENCH_SETTINGS_KEY)).not.toContain(markup.data);
    fireEvent.click(screen.getByTitle('按图生图提交'));
    expect(onSubmitImage).toHaveBeenCalledWith(expect.objectContaining({
      gptImageMarkup: markup, gptImageComplexity: 'low', gptImageOutputFormat: 'webp',
      files: [expect.objectContaining({ id: 'ref-1', dataUrl: firstReference.dataUrl })],
    }));
  });

  it('clears markup associated with the removed first reference while keeping the next reference', async () => {
    const onSubmitImage = vi.fn();
    render(<ImageGenerationWorkbench onSubmitText={vi.fn()} onSubmitImage={onSubmitImage} initialData={{
      model: 'gpt-image-2.6-sunburst', prompt: 'edit the remaining image', refImages: [firstReference, secondReference], gptImageMarkup: markup,
    }} />);
    await screen.findByText('已恢复标注层');
    fireEvent.click(screen.getByRole('button', { name: /^移除 first\.png$/ }));
    expect(screen.queryByText('已恢复标注层')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('按图生图提交'));
    expect(onSubmitImage).toHaveBeenCalledWith(expect.objectContaining({
      gptImageMarkup: undefined, files: [expect.objectContaining({ id: 'ref-2' })],
    }));
  });

  it('cleans 2.6 parameters and markup when selecting an older model', async () => {
    const onSubmitImage = vi.fn();
    render(<ImageGenerationWorkbench onSubmitText={vi.fn()} onSubmitImage={onSubmitImage} initialData={{
      model: 'gpt-image-2.6-sunburst', prompt: 'edit the image', refImages: [firstReference], gptImageMarkup: markup,
      gptImageQuality: 'max', gptImageComplexity: 'low', gptImageOutputFormat: 'webp',
    }} />);
    await screen.findByText('已恢复标注层');
    fireEvent.click(screen.getByTitle('模型选择'));
    fireEvent.click(await screen.findByRole('button', { name: /^GPT Image 2$/ }));
    fireEvent.click(screen.getByTitle('按图生图提交'));
    expect(onSubmitImage).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-image-2', gptImageQuality: 'auto', gptImageComplexity: undefined,
      gptImageOutputFormat: undefined, gptImageFrameCount: undefined, gptImageFrameDurationMs: undefined,
      gptImageMarkup: undefined,
    }));
    expect(readSettings()).not.toHaveProperty('gptImageOutputFormat');
  });
});

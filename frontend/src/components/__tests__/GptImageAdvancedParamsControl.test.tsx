import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { GptImageAdvancedParamsControl } from '../GptImageAdvancedParamsControl';
import { DEFAULT_GPT_IMAGE_ADVANCED_PARAMS, type GptImageAdvancedParams } from '@/lib/model-capabilities';

beforeEach(() => localStorage.clear());

describe('GPT Image advanced controls', () => {
  it('offers 2.6 format and complexity choices when the caller handles them', () => {
    const onChange = vi.fn();
    render(<GptImageAdvancedParamsControl model="gpt-image-2.6-flare" value={DEFAULT_GPT_IMAGE_ADVANCED_PARAMS} onChange={onChange} enableExtendedFormats />);
    fireEvent.click(screen.getByTitle('图像参数'));

    expect(screen.getByRole('button', { name: 'SVG 矢量图' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'GIF 动画' })).toBeInTheDocument();
    expect(screen.queryByText('风格', { selector: 'label' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'SVG 矢量图' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ outputFormat: 'svg' }));

    const group = screen.getByText('复杂度', { selector: 'label' }).parentElement!;
    fireEvent.click(within(group).getByRole('button', { name: '低' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ complexity: 'low' }));
  });

  it('offers GIF timing in image edit controls while keeping SVG generation-only', () => {
    const onChange = vi.fn();
    render(<GptImageAdvancedParamsControl model="gpt-image-2.6-sunburst" mode="image-to-image" value={{ ...DEFAULT_GPT_IMAGE_ADVANCED_PARAMS, outputFormat: 'gif' }} onChange={onChange} enableExtendedFormats />);
    fireEvent.click(screen.getByTitle('图像参数'));
    expect(screen.getByRole('button', { name: 'WebP' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'SVG 矢量图' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'GIF 动画' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('GIF 帧数'), { target: { value: '8' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ outputFormat: 'gif', frameCount: 8 }));
    fireEvent.change(screen.getByLabelText('GIF 每帧时长'), { target: { value: '300' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ outputFormat: 'gif', frameDurationMs: 300 }));
  });

  it('does not expose unconnected format fields to existing callers', () => {
    render(<GptImageAdvancedParamsControl model="gpt-image-2.6-flare" value={DEFAULT_GPT_IMAGE_ADVANCED_PARAMS} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTitle('图像参数'));
    expect(screen.queryByText('输出格式')).not.toBeInTheDocument();
    expect(screen.queryByText('复杂度')).not.toBeInTheDocument();
  });

  it('keeps GIF controls within the published preview range', () => {
    const value: GptImageAdvancedParams = { ...DEFAULT_GPT_IMAGE_ADVANCED_PARAMS, outputFormat: 'gif' };
    const onChange = vi.fn();
    render(<GptImageAdvancedParamsControl model="gpt-image-2.6-flare" value={value} onChange={onChange} enableExtendedFormats />);
    fireEvent.click(screen.getByTitle('图像参数'));
    const frames = screen.getByRole('spinbutton', { name: 'GIF 帧数' });
    expect(frames).toHaveValue(9);
    fireEvent.change(frames, { target: { value: '64' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ frameCount: 16 }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'GIF 每帧时长' }), { target: { value: '205' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ frameDurationMs: 210 }));
  });

  it.each(['jpeg', 'gif'] as const)('clears transparent backgrounds when switching to %s', format => {
    const onChange = vi.fn();
    render(<GptImageAdvancedParamsControl model="gpt-image-2.6-flare" value={{ ...DEFAULT_GPT_IMAGE_ADVANCED_PARAMS, background: 'transparent' }} onChange={onChange} enableExtendedFormats />);
    fireEvent.click(screen.getByTitle('图像参数'));
    fireEvent.click(screen.getByRole('button', { name: format === 'jpeg' ? 'JPEG' : 'GIF 动画' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ outputFormat: format, background: 'auto' }));
  });

  it.each(['jpeg', 'gif'] as const)('does not offer transparent backgrounds for %s output', outputFormat => {
    render(<GptImageAdvancedParamsControl model="gpt-image-2.6-flare" value={{ ...DEFAULT_GPT_IMAGE_ADVANCED_PARAMS, outputFormat }} onChange={vi.fn()} enableExtendedFormats />);
    fireEvent.click(screen.getByTitle('图像参数'));
    expect(screen.queryByRole('button', { name: /^透明$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^不透明$/ })).toBeInTheDocument();
  });
});

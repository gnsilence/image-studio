'use client';

import { Check, SlidersHorizontal } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  DEFAULT_GPT_IMAGE_ADVANCED_PARAMS,
  GPT_IMAGE_BACKGROUND_OPTIONS,
  GPT_IMAGE_QUALITY_OPTIONS,
  GPT_IMAGE_STYLE_OPTIONS,
  getGptImageQualityOptions,
  isGrokImage2Model,
  supportsGptImage26,
  type GptImageAdvancedParams,
  type GptImageBackground,
  type GptImageQuality,
  type GptImageStyle,
  type GptImageComplexity,
  type GptImageOutputFormat,
} from '@/lib/model-capabilities';

interface GptImageAdvancedParamsControlProps {
  model?: string;
  value: GptImageAdvancedParams;
  onChange: (value: GptImageAdvancedParams) => void;
  disabled?: boolean;
  variant?: 'ghost' | 'outline';
  size?: 'xs' | 'sm';
  mode?: 'text-to-image' | 'image-to-image';
  enableExtendedFormats?: boolean;
}

function isDefaultValue(value: GptImageAdvancedParams): boolean {
  return (
    value.quality === DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.quality &&
    value.style === DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.style &&
    value.background === DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.background &&
    (value.complexity ?? 'high') === 'high' &&
    (value.outputFormat ?? 'png') === 'png'
  );
}

function formatLabel(value: GptImageAdvancedParams, qualityOnly: boolean): string {
  if (isDefaultValue(value)) return '图像参数';
  const quality = GPT_IMAGE_QUALITY_OPTIONS.find(option => option.value === value.quality)?.label || value.quality;
  if (qualityOnly) return `质量：${quality}`;
  const style = GPT_IMAGE_STYLE_OPTIONS.find(option => option.value === value.style)?.label || value.style;
  const background = GPT_IMAGE_BACKGROUND_OPTIONS.find(option => option.value === value.background)?.label || value.background;
  return `${quality}/${style}/${background}`;
}

export function GptImageAdvancedParamsControl({
  model,
  value,
  onChange,
  disabled = false,
  variant = 'ghost',
  size = 'xs',
  mode = 'text-to-image',
  enableExtendedFormats = false,
}: GptImageAdvancedParamsControlProps) {
  const qualityOnly = isGrokImage2Model(model || '');
  const isImage26 = supportsGptImage26(model || '');
  const showExtendedParams = isImage26 && enableExtendedFormats;
  const qualityOptions = qualityOnly
    ? GPT_IMAGE_QUALITY_OPTIONS.filter(option => option.value === 'auto' || option.value === 'medium' || option.value === 'low')
    : getGptImageQualityOptions(model || '');
  const triggerClass = cn(
    buttonVariants({ variant, size }),
    'gap-1',
  );

  const updateQuality = (quality: GptImageQuality) => onChange({ ...value, quality });
  const updateStyle = (style: GptImageStyle) => onChange({ ...value, style });
  const updateBackground = (background: GptImageBackground) => onChange({ ...value, background });
  const supportsTransparency = !isImage26 || (value.outputFormat !== 'jpeg' && value.outputFormat !== 'gif');
  const outputFormats: { value: GptImageOutputFormat; label: string }[] = [
    { value: 'png', label: 'PNG' },
    { value: 'jpeg', label: 'JPEG' },
    { value: 'webp', label: 'WebP' },
    ...(mode === 'text-to-image' ? [
      { value: 'svg' as const, label: 'SVG 矢量图' },
    ] : []),
    { value: 'gif', label: 'GIF 动画' },
  ];

  return (
    <Popover>
      <PopoverTrigger className={triggerClass} disabled={disabled} title="图像参数">
        <SlidersHorizontal className="h-3 w-3" />
        <span className="shrink-0 truncate text-[11px]">{formatLabel(value, qualityOnly)}{showExtendedParams && value.outputFormat && value.outputFormat !== 'png' ? ` · ${value.outputFormat.toUpperCase()}` : ''}</span>
      </PopoverTrigger>
      <PopoverContent className="max-h-[min(80vh,640px)] w-72 overflow-y-auto p-2" align="start">
        <div className="space-y-3">
          <ParamGroup
            label="质量"
            options={qualityOptions}
            value={value.quality}
            onSelect={updateQuality}
          />
          {!qualityOnly && (
            <>
              {!isImage26 && <ParamGroup
                label="风格"
                options={GPT_IMAGE_STYLE_OPTIONS}
                value={value.style}
                onSelect={updateStyle}
              />}
              <ParamGroup
                label="背景"
                options={GPT_IMAGE_BACKGROUND_OPTIONS.filter(option => supportsTransparency || option.value !== 'transparent')}
                value={value.background}
                onSelect={updateBackground}
              />
            </>
          )}
          {showExtendedParams && (
            <>
              <ParamGroup<GptImageComplexity>
                label="复杂度"
                options={[
                  { value: 'low', label: '低' },
                  { value: 'medium', label: '中' },
                  { value: 'high', label: '高' },
                ]}
                value={value.complexity ?? 'high'}
                onSelect={complexity => onChange({ ...value, complexity })}
              />
              <ParamGroup
                label="输出格式"
                options={outputFormats}
                value={value.outputFormat ?? 'png'}
                onSelect={outputFormat => onChange({
                  ...value,
                  outputFormat,
                  background: (outputFormat === 'jpeg' || outputFormat === 'gif') && value.background === 'transparent' ? 'auto' : value.background,
                })}
              />
              {value.outputFormat === 'gif' && (
                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>GIF 帧数</span>
                    <Input
                      type="number"
                      aria-label="GIF 帧数"
                      min={2}
                      max={16}
                      step={1}
                      value={value.frameCount ?? 9}
                      onChange={event => onChange({ ...value, frameCount: Math.min(16, Math.max(2, Math.round(Number(event.target.value) || 9))) })}
                    />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>每帧时长（毫秒）</span>
                    <Input
                      type="number"
                      aria-label="GIF 每帧时长"
                      min={20}
                      max={2000}
                      step={10}
                      value={value.frameDurationMs ?? 200}
                      onChange={event => onChange({ ...value, frameDurationMs: Math.min(2000, Math.max(20, Math.round((Number(event.target.value) || 200) / 10) * 10)) })}
                    />
                  </label>
                  <p className="col-span-2 text-[11px] text-muted-foreground">GIF 自动选择帧尺寸，提示词中可描述动作和循环方式。</p>
                </div>
              )}
            </>
          )}
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="w-full"
            onClick={() => onChange(DEFAULT_GPT_IMAGE_ADVANCED_PARAMS)}
          >
            {showExtendedParams ? '重置参数' : '重置为自动'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface ParamGroupProps<T extends string> {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onSelect: (value: T) => void;
}

function ParamGroup<T extends string>({ label, options, value, onSelect }: ParamGroupProps<T>) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="grid grid-cols-2 gap-1">
        {options.map(option => (
          <button
            key={option.value}
            type="button"
            onClick={() => onSelect(option.value)}
            className={cn(
              'flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted',
              option.value === value && 'bg-muted font-medium',
            )}
          >
            <span>{option.label}</span>
            {option.value === value && <Check className="h-3.5 w-3.5" />}
          </button>
        ))}
      </div>
    </div>
  );
}

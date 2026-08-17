'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, CloudUpload, FileText, ImagePlus, Info, Layers3, Loader2, Save, SlidersHorizontal, Sparkles, X, Zap } from 'lucide-react';
import { AttachmentChips } from './AttachmentChips';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { MissingApiKeyDialog } from '@/components/MissingApiKeyDialog';
import { QuickPromptDialog } from '@/components/QuickPromptDialog';
import { PromptOptimizeDialog } from '@/components/PromptOptimizeDialog';
import { AgentAssetPickerDialog, AgentTextAssetPickerDialog } from '@/components/agent/AgentAssetPickerDialog';
import { GenerationParamsBar, type GenerationParamsValue } from '@/components/GenerationParamsBar';
import { ConfirmDialog } from '@/components/workspace/dialogs/ConfirmDialog';
import { streamPromptOptimize, type StreamPromptOptimizeHandle } from '@/lib/prompt-optimize-client';
import { loadJsonFromStorage, saveJsonToStorage } from '@/lib/settings-storage';
import { requireDefaultConfiguredTextModel } from '@/lib/model-endpoints';
import { addTextAsset, type TextAsset } from '@/lib/asset-store';
import { getSelectionBlob, getSelectionMimeType, getSelectionName, type ImageAssetSelection } from '@/lib/s3-assets';
import { MODEL_IMAGE_LIMITS, MODEL_OPTIONS, type ModelId } from '@/lib/gemini-config';
import {
  DEFAULT_GPT_IMAGE_ADVANCED_PARAMS,
  detectClosestAspectRatio,
  findReferenceCapableModel,
  getAspectRatioOptions,
  getCustomSizeMaxSide,
  getGptImageAdvancedParamsForModel,
  getModelMaxRefImages,
  getValidOutputSizes,
  normalizeCustomImageSize,
  normalizeModel,
  supportsCustomSize,
  supportsReferenceImages,
  type GptImageAdvancedParams,
  type GptImageBackground,
  type GptImageQuality,
  type GptImageStyle,
  type ParallelCount,
} from '@/lib/model-capabilities';
import { prepareUploadImage, getOptimizationBadge } from '@/lib/upload-image-cache';
import { MAX_UPLOAD_SIZE_BYTES } from '@/lib/constants';
import { dispatchImageActionToast } from '@/lib/image-actions';
import type { AspectRatio, OutputSize, RefImageData } from '@/lib/job-store';
import type { ImageFormSettings } from '@/lib/form-settings';
import type { ImageToImageSubmitInput, TextToImageSubmitInput } from '@/lib/workspace-task-service';
import { cn } from '@/lib/utils';

const WORKBENCH_SETTINGS_KEY = 'nova-image-generation-settings';
const T2I_SETTINGS_KEY = 'nova-t2i-settings';
const I2I_SETTINGS_KEY = 'nova-i2i-settings';
const MAX_ASSET_IMPORTS = 5;

type WorkbenchMode = 'text-to-image' | 'image-to-image';
type WorkbenchSettings = ImageFormSettings;

interface UploadedFile {
  id: string;
  name: string;
  preview: string;
  dataUrl: string;
  mimeType: string;
  badge?: string;
}

interface ImageGenerationWorkbenchProps {
  wideMode?: boolean;
  onSubmitText: (data: TextToImageSubmitInput) => void;
  onSubmitImage: (data: ImageToImageSubmitInput) => void;
  disabled?: boolean;
  onDraftConsumed?: () => void;
  onConfigureApiKey?: () => void;
  initialData?: {
    prompt?: string;
    outputSize?: OutputSize;
    customSize?: string;
    aspectRatio?: AspectRatio;
    temperature?: number;
    model?: ModelId;
    gptImageQuality?: GptImageQuality;
    gptImageStyle?: GptImageStyle;
    gptImageBackground?: GptImageBackground;
    parallelCount?: ParallelCount;
    refImages?: RefImageData[];
  };
  referenceDraft?: {
    id: number;
    refImages: RefImageData[];
    prompt?: string;
  } | null;
}

function hasStoredSettings(settings: Partial<WorkbenchSettings>): boolean {
  return Object.keys(settings).length > 0;
}

function getSettingsFallback(preferImageSettings: boolean): Partial<WorkbenchSettings> {
  const saved = loadJsonFromStorage<WorkbenchSettings>(WORKBENCH_SETTINGS_KEY);
  if (hasStoredSettings(saved)) return saved;

  const primary = loadJsonFromStorage<WorkbenchSettings>(preferImageSettings ? I2I_SETTINGS_KEY : T2I_SETTINGS_KEY);
  if (hasStoredSettings(primary)) return primary;

  return loadJsonFromStorage<WorkbenchSettings>(preferImageSettings ? T2I_SETTINGS_KEY : I2I_SETTINGS_KEY);
}

export function ImageGenerationWorkbench({
  onSubmitText,
  onSubmitImage,
  disabled = false,
  onDraftConsumed,
  onConfigureApiKey,
  initialData,
  referenceDraft,
}: ImageGenerationWorkbenchProps) {
  const [prompt, setPrompt] = useState('');
  const [pendingFiles, setPendingFiles] = useState<UploadedFile[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  const [model, setModel] = useState<ModelId>('gemini-3-pro-image-preview');
  const [outputSize, setOutputSize] = useState<OutputSize>('1K');
  const [customSize, setCustomSize] = useState<string | undefined>(undefined);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('1:1');
  const [temperature, setTemperature] = useState<number>(1);
  const [gptImageAdvancedParams, setGptImageAdvancedParams] = useState<GptImageAdvancedParams>(DEFAULT_GPT_IMAGE_ADVANCED_PARAMS);
  const [parallelCount, setParallelCount] = useState<ParallelCount>(1);
  const [settingsReady, setSettingsReady] = useState(false);

  const [isDragOver, setIsDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [missingApiKeyDialogOpen, setMissingApiKeyDialogOpen] = useState(false);
  const [quickPromptOpen, setQuickPromptOpen] = useState(false);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [textAssetPickerOpen, setTextAssetPickerOpen] = useState(false);
  const [pendingTextAsset, setPendingTextAsset] = useState<TextAsset | null>(null);

  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const [optimizedText, setOptimizedText] = useState('');
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeError, setOptimizeError] = useState<string | null>(null);
  const optimizeHandleRef = useRef<StreamPromptOptimizeHandle | null>(null);

  const modelLimit = MODEL_IMAGE_LIMITS[model] || { max: getModelMaxRefImages(model), description: '最多 1 张参考图片' };
  const maxImages = modelLimit.max;
  const refsSupported = maxImages > 0;
  const aspectRatioOptions = useMemo(() => getAspectRatioOptions(model, outputSize), [model, outputSize]);
  const currentMode: WorkbenchMode = pendingFiles.length > 0 ? 'image-to-image' : 'text-to-image';
  const autoLayoutLocked = outputSize === 'auto';
  const disabledMessage = '请先在设置中配置 Nova API 密钥，配置完成后即可开始生成图片。';

  const handleParamsChange = useCallback((patch: Partial<GenerationParamsValue>) => {
    if (patch.model !== undefined) {
      setModel(patch.model);
      if (!supportsReferenceImages(patch.model)) {
        setPendingFiles((prev) => {
          if (prev.length > 0) {
            setUploadError('当前模型不支持参考图，已清除参考图');
            return [];
          }
          return prev;
        });
      }
    }
    if (patch.outputSize !== undefined) setOutputSize(patch.outputSize);
    if ('customSize' in patch) setCustomSize(patch.customSize);
    if (patch.aspectRatio !== undefined) setAspectRatio(patch.aspectRatio);
    if (patch.temperature !== undefined) setTemperature(patch.temperature);
    if (patch.parallelCount !== undefined) setParallelCount(patch.parallelCount);
    if (patch.gptImageAdvancedParams !== undefined) setGptImageAdvancedParams(patch.gptImageAdvancedParams);
  }, []);

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 240) + 'px';
  }, [prompt]);

  useEffect(() => {
    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) return;

      const useInitial = Boolean(initialData);
      const saved = getSettingsFallback(Boolean(initialData?.refImages?.length));
      const nextModel = normalizeModel(useInitial && initialData?.model ? initialData.model : saved.model);
      const validSizes = getValidOutputSizes(nextModel);
      const nextOutputSize: OutputSize = useInitial && initialData?.outputSize && validSizes.includes(initialData.outputSize)
        ? initialData.outputSize
        : (saved.outputSize && validSizes.includes(saved.outputSize) ? saved.outputSize : validSizes[0]);
      const nextCustomSize = supportsCustomSize(nextModel) && nextOutputSize !== 'auto'
        ? normalizeCustomImageSize(useInitial ? initialData?.customSize : saved.customSize, getCustomSizeMaxSide(nextModel))
        : undefined;
      const validRatios = getAspectRatioOptions(nextModel, nextOutputSize).map(a => a.value);
      const nextAspectRatio: AspectRatio = useInitial && initialData?.aspectRatio && validRatios.includes(initialData.aspectRatio)
        ? initialData.aspectRatio
        : (saved.aspectRatio && validRatios.includes(saved.aspectRatio) ? saved.aspectRatio : (validRatios[0] || '1:1'));
      const nextTemperature = useInitial && typeof initialData?.temperature === 'number' && initialData.temperature >= 0 && initialData.temperature <= 2
        ? initialData.temperature
        : (typeof saved.temperature === 'number' && saved.temperature >= 0 && saved.temperature <= 2 ? saved.temperature : 1);
      const nextAdvancedParams = getGptImageAdvancedParamsForModel(nextModel, {
        quality: useInitial ? initialData?.gptImageQuality : saved.gptImageQuality,
        style: useInitial ? initialData?.gptImageStyle : saved.gptImageStyle,
        background: useInitial ? initialData?.gptImageBackground : saved.gptImageBackground,
      });
      const nextParallelCount: ParallelCount = useInitial && initialData?.parallelCount && [1, 2, 3, 4].includes(initialData.parallelCount)
        ? initialData.parallelCount
        : (saved.parallelCount && [1, 2, 3, 4].includes(saved.parallelCount) ? saved.parallelCount : 1);

      setModel(nextModel);
      setOutputSize(nextOutputSize);
      setCustomSize(nextCustomSize);
      setAspectRatio(nextAspectRatio);
      setTemperature(nextTemperature);
      setGptImageAdvancedParams(nextAdvancedParams);
      setParallelCount(nextParallelCount);
      if (useInitial) {
        setPrompt(initialData?.prompt || '');
        setPendingFiles((initialData?.refImages || []).map(img => ({
          id: img.id,
          name: img.name,
          preview: img.dataUrl,
          dataUrl: img.dataUrl,
          mimeType: img.mimeType,
          badge: img.badge || '已恢复',
        })));
      }

      setSettingsReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, [initialData]);

  useEffect(() => {
    if (!settingsReady) return;
    saveJsonToStorage(WORKBENCH_SETTINGS_KEY, {
      model,
      outputSize,
      customSize,
      aspectRatio,
      temperature,
      gptImageQuality: gptImageAdvancedParams.quality,
      gptImageStyle: gptImageAdvancedParams.style,
      gptImageBackground: gptImageAdvancedParams.background,
      parallelCount,
    });
  }, [model, outputSize, customSize, aspectRatio, temperature, gptImageAdvancedParams, parallelCount, settingsReady]);

  const handleOptimize = useCallback(() => {
    const textModel = requireDefaultConfiguredTextModel('promptOptimize');
    if (!prompt.trim()) return;

    optimizeHandleRef.current?.abort();
    setOptimizedText('');
    setOptimizeError(null);
    setOptimizing(true);
    setOptimizeOpen(true);

    const images = pendingFiles.map(f => ({ dataUrl: f.dataUrl, mimeType: f.mimeType }));
    const handle = streamPromptOptimize(
      { apiKey: textModel.apiKey, model: textModel.id, mode: currentMode, prompt: prompt.trim(), ...(images.length > 0 ? { images } : {}) },
      {
        onDelta(token) { setOptimizedText(prev => prev + token); },
        onDone() { setOptimizing(false); },
        onError(err) { setOptimizeError(err.message); setOptimizing(false); },
      },
      textModel.baseUrl,
    );
    optimizeHandleRef.current = handle;
  }, [currentMode, pendingFiles, prompt]);

  const handleOptimizeCancel = useCallback(() => {
    optimizeHandleRef.current?.abort();
    optimizeHandleRef.current = null;
    setOptimizing(false);
    setOptimizedText('');
    setOptimizeError(null);
  }, []);

  const handleOptimizeAccept = useCallback(() => {
    if (optimizedText) setPrompt(optimizedText);
    optimizeHandleRef.current = null;
    setOptimizedText('');
    setOptimizeError(null);
  }, [optimizedText]);

  const consumedDraftRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!referenceDraft?.refImages.length) return;
    if (consumedDraftRef.current === referenceDraft.id) return;
    consumedDraftRef.current = referenceDraft.id;
    if (referenceDraft.prompt) {
      setPrompt(referenceDraft.prompt);
    }

    let activeModel = model;
    let activeMax = maxImages;
    if (!supportsReferenceImages(activeModel) || activeMax <= 0) {
      const switched = findReferenceCapableModel(activeModel);
      if (!switched) {
        setUploadError('当前没有支持参考图的模型，请先在设置中配置可编辑模型');
        onDraftConsumed?.();
        return;
      }
      activeModel = switched;
      activeMax = getModelMaxRefImages(switched);
      setModel(switched);
      const nextSizes = getValidOutputSizes(switched);
      const nextSize = nextSizes.includes(outputSize) ? outputSize : nextSizes[0];
      setOutputSize(nextSize);
      if (nextSize === 'auto') {
        setAspectRatio('auto');
        setCustomSize(undefined);
      } else {
        const ratios = getAspectRatioOptions(switched, nextSize).map((item) => item.value);
        if (!ratios.includes(aspectRatio)) setAspectRatio(ratios[0] || '1:1');
        if (!supportsCustomSize(switched)) setCustomSize(undefined);
      }
      setGptImageAdvancedParams(getGptImageAdvancedParamsForModel(switched, gptImageAdvancedParams));
      const label = MODEL_OPTIONS.find((o) => o.value === switched)?.label || switched;
      dispatchImageActionToast(`已切换到支持参考图的模型：${label}`, 'info');
    }

    setPendingFiles((prev) => {
      const existingIds = new Set(prev.map((file) => file.id));
      const remainingSlots = Math.max(0, activeMax - prev.length);
      if (remainingSlots <= 0) {
        setUploadError(`${MODEL_OPTIONS.find((o) => o.value === activeModel)?.label} 最多支持 ${activeMax} 张参考图`);
        return prev;
      }
      const incoming: UploadedFile[] = referenceDraft.refImages
        .filter((img) => !existingIds.has(img.id))
        .slice(0, remainingSlots)
        .map((img) => ({
          id: img.id,
          name: img.name,
          preview: img.dataUrl,
          dataUrl: img.dataUrl,
          mimeType: img.mimeType,
          badge: img.badge || '参考',
        }));
      if (incoming.length < referenceDraft.refImages.length) {
        setUploadError(`${MODEL_OPTIONS.find((o) => o.value === activeModel)?.label} 最多支持 ${activeMax} 张参考图，已添加可容纳的图片`);
      } else {
        setUploadError(null);
      }
      return incoming.length > 0 ? [...prev, ...incoming] : prev;
    });
    onDraftConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- referenceDraft.id is the stable identity; refImages is consumed via ref guard
  }, [maxImages, model, onDraftConsumed, referenceDraft?.id]);

  const detectImageAspectRatio = useCallback(async (dataUrl: string): Promise<AspectRatio | null> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(detectClosestAspectRatio(img.width, img.height, aspectRatioOptions));
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }, [aspectRatioOptions]);

  const processFiles = useCallback(async (fileList: FileList | File[]) => {
    if (maxImages <= 0) {
      setUploadError('当前模型不支持参考图，请切换到支持编辑的模型');
      return;
    }
    const filesToProcess = Array.from(fileList).filter(f => f.type.startsWith('image/'));
    if (filesToProcess.length === 0) {
      setUploadError('请选择图像文件');
      return;
    }
    if (pendingFiles.length + filesToProcess.length > maxImages) {
      setUploadError(`${MODEL_OPTIONS.find(o => o.value === model)?.label} ${modelLimit.description}`);
      return;
    }

    setLoading(true);
    setUploadError(null);

    try {
      const newFiles: UploadedFile[] = [];
      let firstDetectedRatio: AspectRatio | null = null;

      for (const file of filesToProcess) {
        const optimized = await prepareUploadImage(file);
        if (optimized.processedSize > MAX_UPLOAD_SIZE_BYTES) {
          setUploadError(`文件过大: ${file.name}，压缩后仍超过 10MB`);
          continue;
        }

        if (!autoLayoutLocked && newFiles.length === 0 && pendingFiles.length === 0) {
          firstDetectedRatio = await detectImageAspectRatio(optimized.preview);
        }

        newFiles.push({
          id: optimized.id,
          name: optimized.name,
          preview: optimized.preview,
          dataUrl: optimized.dataUrl,
          mimeType: optimized.mimeType,
          badge: getOptimizationBadge(optimized.originalSize, optimized.processedSize, optimized.cacheHit),
        });
      }

      setPendingFiles(prev => {
        const existingIds = new Set(prev.map(f => f.id));
        const uniqueNew = newFiles.filter(f => !existingIds.has(f.id));
        return uniqueNew.length > 0 ? [...prev, ...uniqueNew] : prev;
      });

      if (firstDetectedRatio && pendingFiles.length === 0) {
        setAspectRatio(firstDetectedRatio);
      }
    } catch {
      setUploadError('文件读取失败');
    } finally {
      setLoading(false);
    }
  }, [autoLayoutLocked, detectImageAspectRatio, maxImages, model, pendingFiles.length]);

  const handleImportAssets = useCallback(async (selectedAssets: ImageAssetSelection[]) => {
    if (selectedAssets.length === 0) return;
    if (maxImages <= 0) {
      setUploadError('当前模型不支持参考图，请切换到支持编辑的模型');
      return;
    }

    const remainingSlots = Math.max(0, maxImages - pendingFiles.length);
    if (remainingSlots <= 0) {
      setUploadError(`${MODEL_OPTIONS.find(o => o.value === model)?.label} 最多支持 ${maxImages} 张参考图`);
      return;
    }

    setLoading(true);
    setUploadError(null);

    try {
      const importedFiles: UploadedFile[] = [];
      let firstDetectedRatio: AspectRatio | null = null;

      for (const asset of selectedAssets.slice(0, Math.min(remainingSlots, MAX_ASSET_IMPORTS))) {
        const blob = await getSelectionBlob(asset);
        if (!blob) continue;

        const assetName = getSelectionName(asset);
        const file = new File([blob], assetName, { type: getSelectionMimeType(asset) || blob.type || 'image/png' });
        const optimized = await prepareUploadImage(file);

        if (optimized.processedSize > MAX_UPLOAD_SIZE_BYTES) {
          setUploadError(`文件过大: ${assetName}，压缩后仍超过 10MB`);
          continue;
        }

        if (!autoLayoutLocked && importedFiles.length === 0 && pendingFiles.length === 0) {
          firstDetectedRatio = await detectImageAspectRatio(optimized.preview);
        }

        importedFiles.push({
          id: optimized.id,
          name: optimized.name,
          preview: optimized.preview,
          dataUrl: optimized.dataUrl,
          mimeType: optimized.mimeType,
          badge: asset.source === 's3' ? 'S3' : '素材库',
        });
      }

      setPendingFiles(prev => {
        const existingIds = new Set(prev.map(f => f.id));
        const uniqueImported = importedFiles.filter(f => !existingIds.has(f.id));
        return uniqueImported.length > 0 ? [...prev, ...uniqueImported] : prev;
      });

      if (firstDetectedRatio && pendingFiles.length === 0) {
        setAspectRatio(firstDetectedRatio);
      }

      if (selectedAssets.length > remainingSlots) {
        setUploadError(`${MODEL_OPTIONS.find(o => o.value === model)?.label} 最多支持 ${maxImages} 张参考图，已导入可容纳的图片`);
      }
    } catch {
      setUploadError('素材导入失败');
    } finally {
      setLoading(false);
    }
  }, [autoLayoutLocked, detectImageAspectRatio, maxImages, model, pendingFiles.length]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (!disabled && e.dataTransfer.files.length > 0) {
      void processFiles(e.dataTransfer.files);
    }
  }, [disabled, processFiles]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!disabled) setIsDragOver(true);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      void processFiles(e.target.files);
      e.target.value = '';
    }
  };

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (disabled || loading || maxImages <= 0) return;
      const target = e.target as HTMLElement;
      if (!formRef.current?.contains(target)) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        void processFiles(imageFiles);
      }
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [disabled, loading, maxImages, processFiles]);

  const handleRemovePending = useCallback((id: string) => {
    setPendingFiles(prev => prev.filter(f => f.id !== id));
  }, []);

  const applyTextAsset = useCallback((asset: TextAsset) => {
    setPrompt(asset.content);
    setPendingTextAsset(null);
  }, []);

  const handleTextAssetConfirm = useCallback((asset: TextAsset) => {
    if (prompt.trim() && prompt.trim() !== asset.content.trim()) {
      setPendingTextAsset(asset);
      return;
    }
    applyTextAsset(asset);
  }, [applyTextAsset, prompt]);

  const handleSavePromptAsset = useCallback(async () => {
    if (!prompt.trim()) return;
    try {
      await addTextAsset({
        content: prompt,
        sourceKind: currentMode,
        sourceLabel: '生图工作台',
      });
      dispatchImageActionToast('提示词素材已保存', 'success');
    } catch (error) {
      dispatchImageActionToast(error instanceof Error ? error.message : '保存提示词素材失败', 'error');
    }
  }, [currentMode, prompt]);

  const handleSubmit = () => {
    if (!prompt.trim() || disabled || loading) return;

    const modelWithBilling = model;
    if (pendingFiles.length > 0) {
      onSubmitImage({
        prompt: prompt.trim(),
        files: pendingFiles,
        outputSize,
        customSize,
        aspectRatio,
        temperature,
        model: modelWithBilling,
        gptImageQuality: gptImageAdvancedParams.quality,
        gptImageStyle: gptImageAdvancedParams.style,
        gptImageBackground: gptImageAdvancedParams.background,
        parallelCount,
      });
    } else {
      onSubmitText({
        prompts: [prompt.trim()],
        outputSize,
        customSize,
        aspectRatio,
        temperature,
        model: modelWithBilling,
        gptImageQuality: gptImageAdvancedParams.quality,
        gptImageStyle: gptImageAdvancedParams.style,
        gptImageBackground: gptImageAdvancedParams.background,
        parallelCount,
      });
    }

    setPendingFiles([]);
    setPrompt('');
    setUploadError(null);
    onDraftConsumed?.();
  };

  const handleClearDraft = () => {
    setPrompt('');
    setPendingFiles([]);
    setUploadError(null);
    onDraftConsumed?.();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const canSubmit = prompt.trim().length > 0 && !disabled && !loading;
  const canClear = prompt.trim().length > 0 || pendingFiles.length > 0;

  return (
    <div ref={formRef} className="studio-workbench space-y-3">
      <div className="nova-studio-panel overflow-hidden rounded-xl border border-border bg-card">
        {disabled ? (
          <div className="flex min-h-56 flex-col items-center justify-center gap-4 px-4 py-8 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Info className="h-5 w-5" />
            </div>
            <div className="max-w-md">
              <p className="text-base font-medium text-foreground">API 密钥未配置</p>
              <p className="mt-2 text-sm text-muted-foreground">{disabledMessage}</p>
            </div>
            <Button onClick={() => setMissingApiKeyDialogOpen(true)}>配置</Button>
          </div>
        ) : (
          <>
            <div className="studio-workbench-head flex flex-col gap-3 border-b border-border px-3 py-3 sm:px-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <SlidersHorizontal className="size-3.5" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">创作设置</p>
                    <p className="truncate text-xs text-muted-foreground">选择模型与生成规格</p>
                  </div>
                </div>
                <span className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium',
                  currentMode === 'image-to-image'
                    ? 'border-primary/25 bg-primary/10 text-primary'
                    : 'border-border bg-muted/50 text-muted-foreground',
                )}>
                  <Layers3 className="size-3" />
                  {currentMode === 'image-to-image' ? '图生图' : '文生图'}
                </span>
              </div>
              <GenerationParamsBar
                value={{ model, outputSize, customSize, aspectRatio, temperature, parallelCount, gptImageAdvancedParams }}
                onChange={handleParamsChange}
                className="studio-params-bar"
              />
            </div>

            <div className="p-3 sm:p-4">
              <div className="studio-prompt-surface overflow-hidden rounded-lg border border-border bg-background">
                <Textarea
                  ref={textareaRef}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={pendingFiles.length > 0 ? '描述如何调整参考图...' : '描述你想要生成的图像...'}
                  rows={3}
                  className="min-h-44 resize-none rounded-none border-0 bg-transparent px-3 py-3 text-sm leading-6 placeholder:text-placeholder focus-visible:border-0 focus-visible:ring-0 sm:px-4"
                />
                <div className="flex items-center justify-between gap-2 border-t border-border bg-muted/35 px-2 py-2 sm:px-3">
                  <div className="flex items-center gap-0.5">
                    <Button variant="ghost" size="icon-sm" onClick={() => setQuickPromptOpen(true)} title="快速提示词">
                      <Zap className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => setTextAssetPickerOpen(true)} title="导入提示词素材">
                      <FileText className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => void handleSavePromptAsset()} disabled={!prompt.trim()} title="存为提示词素材">
                      <Save className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={handleOptimize} disabled={!prompt.trim()} title="优化提示词">
                      <Sparkles className="w-4 h-4" />
                    </Button>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button variant="ghost" size="icon-sm" onClick={handleClearDraft} disabled={!canClear} title="清空提示词和图片">
                      <X className="w-4 h-4" />
                    </Button>
                    <Button
                      onClick={handleSubmit}
                      disabled={!canSubmit}
                      size="sm"
                      className="min-w-24 justify-center"
                      title={currentMode === 'image-to-image' ? '按图生图提交' : '按文生图提交'}
                    >
                      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
                      <span>生成图像</span>
                    </Button>
                  </div>
                </div>
              </div>

              <div
                onDrop={refsSupported ? handleDrop : undefined}
                onDragOver={refsSupported ? handleDragOver : (e) => e.preventDefault()}
                onDragLeave={() => setIsDragOver(false)}
                className={cn(
                  'studio-reference-rail mt-3 flex min-h-18 flex-col gap-2 rounded-lg border px-3 py-2.5 transition-colors sm:flex-row sm:items-center',
                  !refsSupported
                    ? 'border-border/70 bg-muted/30 opacity-70'
                    : isDragOver
                      ? 'border-primary bg-primary/10'
                      : 'border-border bg-muted/20',
                )}
              >
                <div className="flex shrink-0 items-center gap-2 sm:w-28">
                  <span className={cn('flex size-7 items-center justify-center rounded-md', refsSupported ? 'bg-muted text-muted-foreground' : 'bg-muted/60 text-muted-foreground')}>
                    <ImagePlus className="size-3.5" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground">参考图</p>
                    <p className="text-[11px] text-muted-foreground">{refsSupported ? `${pendingFiles.length} / ${maxImages} 张` : '当前模型不支持'}</p>
                  </div>
                </div>

                <div className="min-w-0 flex-1">
                  {pendingFiles.length > 0 ? (
                    <AttachmentChips
                      files={pendingFiles}
                      onRemove={handleRemovePending}
                      sourceKind="upload"
                      sourceLabel="生图参考图"
                      prompt={prompt}
                      showDownload={false}
                      showCopy
                      showUseAsReference={false}
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground">添加参考图或直接粘贴图片后即可进行图像编辑</p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <div className="relative">
                    <Button variant="outline" size="sm" disabled={loading || !refsSupported || pendingFiles.length >= maxImages} title={refsSupported ? '上传参考图' : '当前模型不支持参考图'}>
                      <CloudUpload className="size-3.5" />
                      <span>上传</span>
                    </Button>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handleFileSelect}
                      disabled={loading || !refsSupported || pendingFiles.length >= maxImages}
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                      aria-label="上传参考图"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setAssetPickerOpen(true)}
                    disabled={loading || !refsSupported || pendingFiles.length >= maxImages}
                    title={refsSupported ? '从素材库导入参考图' : '当前模型不支持参考图'}
                  >
                    <ImagePlus className="size-3.5" />
                    <span>素材库</span>
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {uploadError && <p className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">{uploadError}</p>}
      <MissingApiKeyDialog
        open={missingApiKeyDialogOpen}
        onOpenChange={setMissingApiKeyDialogOpen}
        onConfigure={() => onConfigureApiKey?.()}
      />
      <QuickPromptDialog
        open={quickPromptOpen}
        onOpenChange={setQuickPromptOpen}
        currentMode={currentMode}
        currentPrompt={prompt}
        onSelect={setPrompt}
      />
      <PromptOptimizeDialog
        open={optimizeOpen}
        onOpenChange={(open) => { if (!open) handleOptimizeCancel(); setOptimizeOpen(open); }}
        originalPrompt={prompt}
        optimizedPrompt={optimizedText}
        loading={optimizing}
        error={optimizeError}
        onAccept={handleOptimizeAccept}
        onCancel={handleOptimizeCancel}
      />
      <AgentAssetPickerDialog
        open={assetPickerOpen}
        maxSelected={Math.min(MAX_ASSET_IMPORTS, Math.max(1, maxImages - pendingFiles.length))}
        onOpenChange={setAssetPickerOpen}
        onConfirm={(assets) => void handleImportAssets(assets)}
        onConfigure={onConfigureApiKey}
      />
      <AgentTextAssetPickerDialog
        open={textAssetPickerOpen}
        onOpenChange={setTextAssetPickerOpen}
        onConfirm={handleTextAssetConfirm}
      />
      {pendingTextAsset && createPortal(
        <ConfirmDialog
          title="覆盖当前提示词"
          message="将用素材内容覆盖当前输入框，是否继续？"
          confirmText="覆盖"
          variant="default"
          onConfirm={() => applyTextAsset(pendingTextAsset)}
          onCancel={() => setPendingTextAsset(null)}
        />,
        document.body,
      )}
    </div>
  );
}

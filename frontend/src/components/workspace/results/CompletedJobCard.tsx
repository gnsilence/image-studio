'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Copy, Download, ImagePlus, Images, Loader2, Maximize, RotateCcw, Thermometer, Workflow, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Button, buttonVariants } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useImageLazyLoad } from '@/hooks/useImageLazyLoad';
import { getImageSrc, type StoredJob } from '@/lib/job-store';
import { resolveStoredImageRef, revokeBlobUrls } from '@/lib/image-downloader';
import { getModelDisplayName, getOutputSizeLabel } from '@/lib/model-capabilities';
import { HistoryImagePreview } from '@/components/workspace/results/HistoryImagePreview';
import { ConfirmDialog } from '@/components/workspace/dialogs/ConfirmDialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { CanvasTaskImportRequest } from '@/components/canvas/canvas-job-import';
import {
  copyImagePayload,
  dispatchImageActionToast,
  runImageAction,
  type ImageActionPayload,
} from '@/lib/image-actions';

interface CompletedJobCardProps {
  job: StoredJob;
  onClear: () => void;
  onRetry: (job: StoredJob) => void;
  onImportToCanvas: (request: CanvasTaskImportRequest) => void;
}

export const CompletedJobCard = memo(function CompletedJobCard({ job, onClear, onRetry, onImportToCanvas }: CompletedJobCardProps) {
  const [imgCopied, setImgCopied] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewImages, setPreviewImages] = useState<string[]>([]);
  const [referencePreviewOpen, setReferencePreviewOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [assetMenuOpen, setAssetMenuOpen] = useState(false);
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const [canvasImportOpen, setCanvasImportOpen] = useState(false);
  const [canvasImportLoading, setCanvasImportLoading] = useState(false);
  const [canvasImportPreviews, setCanvasImportPreviews] = useState<(string | undefined)[]>([]);
  const [selectedCanvasImageIndexes, setSelectedCanvasImageIndexes] = useState<number[]>([]);
  const [includeCanvasReferences, setIncludeCanvasReferences] = useState(true);

  const sourceImages = useMemo(() => job.images || (job.imageData ? [job.imageData] : []), [job.imageData, job.images]);
  const [images, setImages] = useState(sourceImages);
  const resolvedBlobUrlsRef = useRef<string[]>([]);
  const actionPayloads = useMemo<ImageActionPayload[]>(() => sourceImages.map((imageRef, index) => ({
    id: `${job.id}-${index}`,
    name: `nova-image-${job.id.slice(0, 8)}${sourceImages.length > 1 ? `-${index + 1}` : ''}`,
    storedRef: { jobId: job.id, imageRef, imageIndex: index },
    sourceKind: job.mode === 'image-to-image' ? 'image-to-image' : 'text-to-image',
    sourceLabel: job.mode === 'image-to-image' ? '图生图历史结果' : '文生图历史结果',
    sourceRef: `${job.id}:${index}`,
    prompt: job.prompt,
  })), [job.id, job.mode, job.prompt, sourceImages]);
  const referenceImages = useMemo(
    () => (job.refImages || []).map(refImage => refImage.dataUrl).filter((dataUrl): dataUrl is string => !!dataUrl),
    [job.refImages]
  );
  const referencePayloads = useMemo<ImageActionPayload[]>(() => (
    (job.refImages || [])
      .filter(refImage => !!refImage.dataUrl)
      .map((refImage, index) => ({
        id: `${job.id}-ref-${index}`,
        name: refImage.name || `reference-${index + 1}`,
        src: refImage.dataUrl,
        dataUrl: refImage.dataUrl,
        mimeType: refImage.mimeType,
        sourceKind: 'image-to-image',
        sourceLabel: '图生图参考图',
        sourceRef: `${job.id}:ref:${index}`,
        prompt: job.prompt,
      }))
  ), [job.id, job.prompt, job.refImages]);
  const hasReferenceImages = job.mode === 'image-to-image' && referenceImages.length > 0;

  const revokeResolvedBlobUrls = useCallback(() => {
    if (resolvedBlobUrlsRef.current.length > 0) {
      revokeBlobUrls(resolvedBlobUrlsRef.current);
      resolvedBlobUrlsRef.current = [];
    }
  }, []);

  useEffect(() => {
    setImages(sourceImages);
    return revokeResolvedBlobUrls;
  }, [revokeResolvedBlobUrls, sourceImages]);

  useEffect(() => {
    const urls = job.blobUrls;
    return () => {
      if (urls) {
        revokeBlobUrls(urls);
      }
    };
  }, [job.blobUrls]);

  const resolveImageAt = useCallback(async (index: number): Promise<string | undefined> => {
    const image = images[index] || sourceImages[index];
    if (!image) return undefined;
    if (image.startsWith('blob:') && image !== sourceImages[index]) return image;
    if (!image.startsWith('IDB:') && !image.startsWith('blob:')) return image;

    const resolved = await resolveStoredImageRef(job.id, image, index);
    if (resolved.blobUrl) {
      resolvedBlobUrlsRef.current.push(resolved.blobUrl);
      setImages(prev => prev.map((item, itemIndex) => (itemIndex === index ? resolved.image : item)));
    }

    return resolved.image;
  }, [images, job.id, sourceImages]);

  const resolveImagesAt = useCallback(async (indexes: number[]): Promise<string[]> => {
    const resolved = await Promise.all(indexes.map(index => resolveImageAt(index)));
    return resolved.filter((image): image is string => !!image);
  }, [resolveImageAt]);

  const visiblePreviewImages = images.slice(0, 3);
  const isMultiple = sourceImages.length > 1;
  const supportsTemperature = !job.model.startsWith('gpt-image-2');
  const outputSizeLabel = job.custom_size || getOutputSizeLabel(job.output_size);
  const lazyLoad = useImageLazyLoad<HTMLDivElement>({
    rootMargin: '300px',
    enabled: true,
  });
  // 单独跟踪每个可见缩略图的加载状态，避免单图失败导致全部不显示
  const [loadedImageIndices, setLoadedImageIndices] = useState<Set<number>>(new Set());
  const [failedImageIndices, setFailedImageIndices] = useState<Set<number>>(new Set());
  const handleImageLoad = useCallback((index: number) => {
    setLoadedImageIndices(prev => new Set(prev).add(index));
    // 第一张图加载完成时同步更新lazyLoad状态
    if (index === 0) {
      lazyLoad.handleImageLoad();
    }
  }, [lazyLoad]);
  const handleImageError = useCallback((index: number) => {
    setFailedImageIndices(prev => new Set(prev).add(index));
    if (index === 0) {
      lazyLoad.handleImageLoad();
    }
  }, [lazyLoad]);

  const downloadImage = (index: number = 0) => {
    const payload = actionPayloads[index];
    if (!payload) return;
    void runImageAction('download', payload);
  };

  const addImageToAssets = (index: number = 0) => {
    const payload = actionPayloads[index];
    if (!payload) return;
    void runImageAction('add-to-assets', payload);
  };

  const addAllToAssets = () => {
    actionPayloads.forEach((_, index) => {
      setTimeout(() => addImageToAssets(index), index * 100);
    });
    setAssetMenuOpen(false);
  };

  const downloadAll = () => {
    actionPayloads.forEach((_, index) => {
      setTimeout(() => downloadImage(index), index * 100);
    });
    setDownloadMenuOpen(false);
  };

  const copyImage = async (index: number = 0) => {
    const payload = actionPayloads[index];
    if (!payload) return;
    try {
      await copyImagePayload(payload);
      setImgCopied(true);
      setTimeout(() => setImgCopied(false), 2000);
      setCopyMenuOpen(false);
      dispatchImageActionToast('图片已复制', 'success');
    } catch (error) {
      setCopyMenuOpen(false);
      const message = error instanceof Error ? error.message : '图片复制失败';
      dispatchImageActionToast(message.includes('Failed to fetch') ? '该图片源不允许本地保存或复制，请直接右键/长摁复制' : message, 'error');
    }
  };

  const copyPrompt = () => {
    navigator.clipboard.writeText(job.prompt);
    setPromptCopied(true);
    setTimeout(() => setPromptCopied(false), 2000);
  };

  const openCanvasImport = async () => {
    setCanvasImportOpen(true);
    setCanvasImportLoading(true);
    setSelectedCanvasImageIndexes(sourceImages.map((_, index) => index));
    setIncludeCanvasReferences(true);
    const previews = await Promise.all(sourceImages.map((_, index) => resolveImageAt(index)));
    setCanvasImportPreviews(previews);
    setCanvasImportLoading(false);
  };

  const confirmCanvasImport = () => {
    if (!selectedCanvasImageIndexes.length) return;
    onImportToCanvas({
      job,
      imageIndexes: selectedCanvasImageIndexes,
      includeReferenceImages: includeCanvasReferences,
    });
    setCanvasImportOpen(false);
  };

  const openPreview = async () => {
    const resolved = await resolveImagesAt(sourceImages.map((_, index) => index));
    setPreviewImages(resolved.map(getImageSrc).filter(Boolean));
    setPreviewOpen(true);
  };

  useEffect(() => {
    if (!lazyLoad.isVisible) return;
    void resolveImageAt(0);
  }, [lazyLoad.isVisible, resolveImageAt]);

  if (sourceImages.length === 0) {
    return null;
  }

  return (
    <>
      <article className="studio-result-card overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-col gap-0">
          <div
            ref={lazyLoad.elementRef}
            className="studio-result-media group relative aspect-[4/3] w-full overflow-hidden bg-muted/35"
          >
            <button
              type="button"
              onClick={() => void openPreview()}
              className="absolute inset-0 h-full w-full border-0 p-3"
              title="看大图"
            >
              {isMultiple ? (
                <div className="grid h-full w-full grid-cols-2 gap-2">
                  {visiblePreviewImages.map((image, index) => (
                    <div key={`${job.id}-${index}`} className="relative min-h-0 overflow-hidden rounded-md bg-background/70">
                      <img
                        src={lazyLoad.isVisible ? (getImageSrc(image) || undefined) : undefined}
                        alt={`生成的图像 ${index + 1}`}
                        className={`h-full w-full object-contain transition-opacity duration-300 ${
                          loadedImageIndices.has(index) ? 'opacity-100' : 'opacity-0'
                        }`}
                        onLoad={() => handleImageLoad(index)}
                        onError={() => handleImageError(index)}
                      />
                      {failedImageIndices.has(index) && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-xs text-muted-foreground">
                          <AlertCircle className="size-4" />
                          <span>图片已失效</span>
                        </div>
                      )}
                    </div>
                  ))}
                  {!lazyLoad.isLoaded && (
                    <div className="absolute inset-0 z-10 animate-pulse bg-gradient-to-r from-muted via-muted/50 to-muted" />
                  )}
                  <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                    <Maximize className="size-5 text-white" />
                  </div>
                </div>
              ) : (
                <>
                <img
                  src={lazyLoad.isVisible ? (getImageSrc(images[0]) || undefined) : undefined}
                  alt="生成的图像"
                  className={`h-full w-full rounded-md object-contain transition-opacity duration-300 ${lazyLoad.isLoaded ? 'opacity-100' : 'opacity-0'}`}
                  onLoad={lazyLoad.handleImageLoad}
                  onError={() => handleImageError(0)}
                />
                {failedImageIndices.has(0) && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-xs text-muted-foreground">
                    <AlertCircle className="size-4" />
                    <span>图片已失效</span>
                  </div>
                )}
                {!lazyLoad.isLoaded && (
                  <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-muted via-muted/50 to-muted" />
                )}
                <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                  <Maximize className="size-5 text-white" />
                </div>
                </>
              )}
            </button>
          </div>

          <div className="min-w-0 w-full px-3 pt-3">
            <div className="flex items-center gap-1.5">
              <p className="line-clamp-2 text-sm leading-5 text-foreground">&quot;{job.prompt}&quot;</p>
              <button
                onClick={copyPrompt}
                className="flex-shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="复制提示词"
              >
                {promptCopied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>

            {job.warning && (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-warning">
                <AlertCircle className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{job.warning}</span>
              </p>
            )}

            <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
              {getModelDisplayName(job.model)}
              <span>·</span>
              {outputSizeLabel}
              {job.aspect_ratio !== '1:1' && job.aspect_ratio !== 'auto' && <><span>·</span><span>{job.aspect_ratio}</span></>}
              {supportsTemperature && <><span>·</span><Thermometer className="w-3 h-3" /><span>{job.temperature?.toFixed(2) ?? 1}</span></>}
              {isMultiple && <><span>·</span><span className="font-medium text-primary">x{sourceImages.length}{job.parallelCount && job.parallelCount > sourceImages.length ? `/${job.parallelCount}` : ''}</span></>}
            </p>
          </div>

          <div className="studio-result-toolbar flex w-full flex-shrink-0 items-center justify-end gap-1 border-t border-border px-3 py-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void openCanvasImport()}
              title="导入到无限画布"
            >
              <Workflow className="w-4 h-4" />
            </Button>
            {hasReferenceImages && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setReferencePreviewOpen(true)}
                title={`查看参考图 (${referenceImages.length})`}
              >
                <Images className="w-4 h-4" />
              </Button>
            )}

            {isMultiple ? (
              <DropdownMenu open={assetMenuOpen} onOpenChange={setAssetMenuOpen}>
                <DropdownMenuTrigger className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })} title="添加到素材库">
                  <ImagePlus className="w-4 h-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {sourceImages.map((_, index) => (
                    <DropdownMenuItem key={index} onClick={() => {
                      addImageToAssets(index);
                      setAssetMenuOpen(false);
                    }}>
                      保存图片 {index + 1}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem onClick={addAllToAssets} className="font-medium text-primary">
                    <ImagePlus className="mr-1.5 w-3.5 h-3.5" />
                    保存全部
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => addImageToAssets(0)}
                title="添加到素材库"
              >
                <ImagePlus className="w-4 h-4" />
              </Button>
            )}

            {isMultiple ? (
              <DropdownMenu open={downloadMenuOpen} onOpenChange={setDownloadMenuOpen}>
                <DropdownMenuTrigger className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })} title="下载">
                  <Download className="w-4 h-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {sourceImages.map((_, index) => (
                    <DropdownMenuItem key={index} onClick={() => {
                      downloadImage(index);
                      setDownloadMenuOpen(false);
                    }}>
                      下载图片 {index + 1}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem onClick={downloadAll} className="font-medium text-primary">
                    <Download className="mr-1.5 w-3.5 h-3.5" />
                    下载全部
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button variant="ghost" size="icon-sm" onClick={() => downloadImage(0)} title="下载">
                <Download className="w-4 h-4" />
              </Button>
            )}

            {isMultiple ? (
              <DropdownMenu open={copyMenuOpen} onOpenChange={setCopyMenuOpen}>
                <DropdownMenuTrigger className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })} title="复制图片">
                  {imgCopied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {sourceImages.map((_, index) => (
                    <DropdownMenuItem key={index} onClick={() => copyImage(index)}>
                      复制图片 {index + 1}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button variant="ghost" size="icon-sm" onClick={() => copyImage(0)} title="复制图片">
                {imgCopied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
              </Button>
            )}

            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onRetry(job)}
              title="重试"
              className="text-muted-foreground hover:text-primary"
            >
              <RotateCcw className="w-4 h-4" />
            </Button>

            <Button variant="ghost" size="icon-sm" onClick={() => setDeleteDialogOpen(true)} title="移除">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </article>

      {previewOpen && createPortal(
        <HistoryImagePreview
          images={previewImages}
          alt={job.prompt}
          onClose={() => setPreviewOpen(false)}
          actionPayloads={actionPayloads}
        />,
        document.body
      )}

      {referencePreviewOpen && hasReferenceImages && createPortal(
        <HistoryImagePreview
          images={referenceImages}
          alt="图生图参考图"
          onClose={() => setReferencePreviewOpen(false)}
          actionPayloads={referencePayloads}
        />,
        document.body
      )}

      <Dialog open={canvasImportOpen} onOpenChange={setCanvasImportOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>导入到无限画布</DialogTitle>
            <DialogDescription>选择要带入画布的任务结果图，原始提示词会作为文本节点保留。</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              {sourceImages.map((_, index) => {
                const selected = selectedCanvasImageIndexes.includes(index);
                const preview = canvasImportPreviews[index];
                return (
                  <button
                    key={`${job.id}-canvas-import-${index}`}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setSelectedCanvasImageIndexes(current => selected ? current.filter(item => item !== index) : [...current, index])}
                    className={`relative aspect-square overflow-hidden rounded-lg border bg-muted/40 text-left transition-colors ${selected ? 'border-primary ring-2 ring-primary/20' : 'border-border hover:border-primary/50'}`}
                  >
                    {preview ? <img src={getImageSrc(preview)} alt={`任务结果 ${index + 1}`} className="h-full w-full object-contain" /> : (
                      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                        {canvasImportLoading ? <Loader2 className="size-4 animate-spin" /> : '图片不可用'}
                      </div>
                    )}
                    <span className="absolute left-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-xs text-white">结果 {index + 1}</span>
                    {selected && <Check className="absolute right-2 top-2 size-4 rounded-full bg-primary p-0.5 text-primary-foreground" />}
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              aria-pressed={includeCanvasReferences}
              onClick={() => setIncludeCanvasReferences(current => !current)}
              className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors ${includeCanvasReferences ? 'border-primary/50 bg-primary/5' : 'border-border hover:border-primary/40'}`}
            >
              <span className="flex items-center gap-2">
                <Images className="size-4 text-muted-foreground" />
                <span>
                  <span className="block text-sm font-medium">同时导入参考图</span>
                  <span className="block text-xs text-muted-foreground">{referenceImages.length ? `${referenceImages.length} 张参考图将作为独立节点保存` : '该任务没有可用的参考图'}</span>
                </span>
              </span>
              <span className={`flex size-5 items-center justify-center rounded-md border ${includeCanvasReferences ? 'border-primary bg-primary text-primary-foreground' : 'border-border'}`}>
                {includeCanvasReferences && <Check className="size-3.5" />}
              </span>
            </button>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCanvasImportOpen(false)}>取消</Button>
            <Button onClick={confirmCanvasImport} disabled={canvasImportLoading || selectedCanvasImageIndexes.length === 0}>
              <Workflow className="size-4" />
              导入并打开画布
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {deleteDialogOpen && createPortal(
        <ConfirmDialog
          title="删除记录"
          message={
            <>
              确定要删除这条记录吗？此操作无法撤销。
              {isMultiple && <span className="mt-1 block text-warning">这将删除 {sourceImages.length} 张图片。</span>}
            </>
          }
          confirmText="删除"
          onConfirm={onClear}
          onCancel={() => setDeleteDialogOpen(false)}
        />,
        document.body
      )}
    </>
  );
});

'use client';

import { Copy, Download, Gauge, ImagePlus, Maximize2, Settings, Wand2, X, Shuffle, User, Wallpaper, RefreshCw } from 'lucide-react';
import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo, useId, forwardRef, useImperativeHandle } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ThemeToggle } from '@/components/ThemeToggle';
import { WideModeToggle } from '@/components/WideModeToggle';
import type { NovaQueueStatus } from '@/lib/ccode-task-client';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { runImageAction, type ImageActionPayload } from '@/lib/image-actions';

import { BA_RANDOM_URL, BING_WALLPAPER_URL } from '@/lib/constants';

function getDistance(t1: { clientX: number; clientY: number }, t2: { clientX: number; clientY: number }) {
  return Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
}

/** Lock body scroll while mounted, preserving scroll position. */
function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const scrollY = window.scrollY;
    Object.assign(document.body.style, { overflow: 'hidden', position: 'fixed', top: `-${scrollY}px`, width: '100%' });
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.body.style.removeProperty('overflow');
      document.body.style.removeProperty('position');
      document.body.style.removeProperty('top');
      document.body.style.removeProperty('width');
      document.documentElement.style.removeProperty('overflow');
      window.scrollTo(0, scrollY);
    };
  }, [active]);
}

export interface WorkspaceHeaderRef {
  openRandomImage: (url: string, title: string) => void;
}

interface WorkspaceHeaderProps {
  queueStatus: NovaQueueStatus | null;
  wideMode: boolean;
  onToggleWideMode: () => void;
  onOpenSettings: () => void;
  onLogoClick?: () => void;
  sidebarMode?: boolean;
}

export function QueueStatusSummary({
  queueStatus,
  compact = false,
}: {
  queueStatus: NovaQueueStatus | null;
  compact?: boolean;
}) {
  if (!queueStatus) {
    return (
      <div className={cn('nova-queue-summary text-xs text-muted-foreground', compact && 'nova-queue-summary-compact')}>
        服务状态暂不可用
      </div>
    );
  }

  const queueAtCapacity = typeof queueStatus.queuedCount === 'number'
    && typeof queueStatus.maxQueueSize === 'number'
    && queueStatus.queuedCount >= queueStatus.maxQueueSize;

  return (
    <div className={cn('nova-queue-summary space-y-3', compact && 'nova-queue-summary-compact')}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('size-2 rounded-full', queueStatus.acceptingNewTasks ? 'bg-success' : 'bg-destructive')} />
          <span className="text-sm font-medium text-foreground">任务队列</span>
        </div>
        <span className={cn(
          'rounded-md px-1.5 py-0.5 text-[11px] font-medium',
          queueStatus.acceptingNewTasks ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive',
        )}>
          {queueStatus.acceptingNewTasks ? '接收中' : '已暂停'}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="nova-queue-metric">
          <span>并发</span>
          <strong>{queueStatus.processingCount}</strong>
        </div>
        <div className={cn('nova-queue-metric', queueAtCapacity && 'nova-queue-metric-alert')}>
          <span>排队</span>
          <strong>{queueStatus.queuedCount}</strong>
        </div>
        <div className="nova-queue-metric">
          <span>上限</span>
          <strong>{queueStatus.maxQueueSize ?? '-'}</strong>
        </div>
      </div>
      {queueStatus.serverMessage && (
        <p className="rounded-md border border-destructive/20 bg-destructive/10 px-2 py-1.5 text-xs leading-5 text-destructive">
          {queueStatus.serverMessage}
        </p>
      )}
    </div>
  );
}

function QueueStatusControl({ queueStatus }: { queueStatus: NovaQueueStatus | null }) {
  const queueAtCapacity = queueStatus
    && typeof queueStatus.queuedCount === 'number'
    && typeof queueStatus.maxQueueSize === 'number'
    && queueStatus.queuedCount >= queueStatus.maxQueueSize;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        className={cn(
          buttonVariants({ variant: 'outline', size: 'sm' }),
          'nova-queue-trigger gap-1.5 px-2 sm:px-2.5',
          queueAtCapacity && 'border-destructive/35 text-destructive hover:text-destructive',
        )}
        title="任务队列状态"
        aria-label="任务队列状态"
      >
        <Gauge className="size-4" />
        <span className="hidden sm:inline">队列</span>
        {queueStatus && <span className="font-mono text-[11px]">{queueStatus.queuedCount}</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-64 p-3">
        <QueueStatusSummary queueStatus={queueStatus} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const WorkspaceHeader = forwardRef<WorkspaceHeaderRef, WorkspaceHeaderProps>(function WorkspaceHeader(
  { queueStatus, wideMode, onToggleWideMode, onOpenSettings, onLogoClick, sidebarMode = false },
  ref,
) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [imageSrc, setImageSrc] = useState('');
  const [imageTitle, setImageTitle] = useState('');
  const [imageLoading, setImageLoading] = useState(false);
  const [imageApiUrl, setImageApiUrl] = useState('');
  const [viewerPayload, setViewerPayload] = useState<ImageActionPayload | null>(null);
  const viewerObjectUrlRef = useRef<string | null>(null);
  const viewerRequestIdRef = useRef(0);

  useBodyScrollLock(viewerOpen);

  const cleanupViewerObjectUrl = useCallback(() => {
    if (viewerObjectUrlRef.current) {
      URL.revokeObjectURL(viewerObjectUrlRef.current);
      viewerObjectUrlRef.current = null;
    }
  }, []);

  const loadRandomImage = useCallback(async (url: string, title: string, preserveCurrent = false) => {
    const requestId = ++viewerRequestIdRef.current;
    const requestUrl = `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`;
    if (!preserveCurrent) {
      cleanupViewerObjectUrl();
      setImageSrc('');
      setViewerPayload(null);
    }
    setImageApiUrl(url);
    setImageTitle(title);
    setImageLoading(true);
    setViewerOpen(true);
    try {
      const response = await fetch(requestUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (!blob.type.startsWith('image/')) throw new Error('响应不是图片');
      if (requestId !== viewerRequestIdRef.current) return;

      cleanupViewerObjectUrl();
      const objectUrl = URL.createObjectURL(blob);
      viewerObjectUrlRef.current = objectUrl;
      const imageId = `random-${title || 'image'}-${Date.now()}`;
      setViewerPayload({
        id: imageId,
        name: imageId,
        blob,
        mimeType: blob.type,
        sourceKind: 'random',
        sourceLabel: title ? `随机图片：${title}` : '随机图片',
        sourceRef: url,
      });
      setImageSrc(objectUrl);
    } catch {
      if (requestId !== viewerRequestIdRef.current) return;
      const resolvedUrl = new URL(requestUrl, window.location.href);
      if (resolvedUrl.origin !== window.location.origin) {
        cleanupViewerObjectUrl();
        setViewerPayload(null);
        setImageSrc(requestUrl);
        return;
      }
      setImageLoading(false);
      if (!preserveCurrent) setImageSrc('');
    }
  }, [cleanupViewerObjectUrl]);

  /** Open viewer with a fresh random image. */
  const openRandomImage = useCallback((url: string, title: string) => {
    void loadRandomImage(url, title);
  }, [loadRandomImage]);

  useImperativeHandle(ref, () => ({ openRandomImage }), [openRandomImage]);

  /** Refresh current image (same category), append cache-bust param. */
  const handleRefresh = useCallback(() => {
    if (!imageApiUrl) return;
    void loadRandomImage(imageApiUrl, imageTitle, true);
  }, [imageApiUrl, imageTitle, loadRandomImage]);

  /** Called when the <img> finishes loading in the viewer. */
  const handleImageLoaded = useCallback(() => {
    setImageLoading(false);
  }, []);

  /** Stop the spinner when a remote image cannot be displayed. */
  const handleImageError = useCallback(() => {
    setImageLoading(false);
  }, []);

  /** Close the viewer and clean up. */
  const closeRandomImage = useCallback(() => {
    viewerRequestIdRef.current += 1;
    cleanupViewerObjectUrl();
    setViewerOpen(false);
    setImageSrc('');
    setImageTitle('');
    setImageApiUrl('');
    setViewerPayload(null);
  }, [cleanupViewerObjectUrl]);

  useEffect(() => () => cleanupViewerObjectUrl(), [cleanupViewerObjectUrl]);

  return (
    <header className={cn(sidebarMode ? 'xl:pb-0' : 'space-y-3 sm:space-y-5')}>
      <div className="flex items-start justify-between gap-2 sm:gap-4">
        <div className={cn("flex min-w-0 shrink-0 items-center gap-2 sm:gap-3", sidebarMode && 'xl:hidden')}>
          <button
            type="button"
            onClick={onLogoClick}
            className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:rounded-xl"
            aria-label="AIOSS logo"
          >
            <img
              src="/favicon.png"
              alt="AIOSS logo"
              className="h-8 w-8 flex-shrink-0 rounded-lg object-cover ring-1 ring-border/60 sm:h-11 sm:w-11 sm:rounded-xl"
            />
          </button>
          <div className="hidden min-w-0 space-y-1 sm:block">
            <h1 className="truncate text-2xl font-semibold tracking-tight">AIOSS Image</h1>
            <p className="text-sm text-muted-foreground">批量 API 图像生成器</p>
          </div>
        </div>

        <div className={cn('flex min-w-0 flex-1 items-center justify-end gap-1.5 sm:flex-none sm:flex-col sm:items-end sm:gap-2', sidebarMode && 'xl:hidden')}>
          <div className="flex shrink-0 items-center justify-end gap-1.5 sm:max-w-full sm:flex-wrap sm:gap-2">
            <QueueStatusControl queueStatus={queueStatus} />
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-0 px-2 sm:gap-2 sm:px-2.5")}
                title="随机图片"
                aria-label="随机图片"
              >
                <Shuffle className="w-4 h-4" />
                <span className="hidden sm:inline">随机图片</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={4}>
                <DropdownMenuItem onClick={() => openRandomImage(BA_RANDOM_URL, 'BA人物')}>
                  <User className="w-4 h-4" />
                  BA人物
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => openRandomImage(BING_WALLPAPER_URL, 'Bing壁纸')}>
                  <Wallpaper className="w-4 h-4" />
                  Bing壁纸
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <ThemeToggle />
            <WideModeToggle enabled={wideMode} onToggle={onToggleWideMode} />
            <Button variant="outline" size="sm" onClick={onOpenSettings} className="gap-0 px-2 sm:gap-2 sm:px-2.5" title="设置" aria-label="设置">
              <Settings className="w-4 h-4" />
              <span className="hidden sm:inline">设置</span>
            </Button>
          </div>
        </div>
      </div>

      {/* 随机图片全屏查看器 */}
      {viewerOpen && (
        <RandomImageViewer
          src={imageSrc}
          title={imageTitle}
          loading={imageLoading}
          onRefresh={handleRefresh}
          onImageLoaded={handleImageLoaded}
          onImageError={handleImageError}
          onClose={closeRandomImage}
          actionPayload={viewerPayload || undefined}
          canRefresh={!!imageApiUrl}
        />
      )}
    </header>
  );
});

/* ── Fullscreen image viewer with zoom / pan / drag ──────────────────── */

interface ViewerProps {
  src: string;
  title: string;
  loading: boolean;
  onRefresh: () => void;
  onImageLoaded: () => void;
  onImageError: () => void;
  onClose: () => void;
  actionPayload?: ImageActionPayload;
  canRefresh?: boolean;
}

function RandomImageViewer({ src, title, loading, onRefresh, onImageLoaded, onImageError, onClose, actionPayload, canRefresh = true }: ViewerProps) {
  const instanceId = useId();
  const imageRef = useRef<HTMLImageElement>(null);
  const frameRef = useRef<number | null>(null);
  const scaleRef = useRef(1);
  const posRef = useRef({ x: 0, y: 0 });
  const [scaleState, setScaleState] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const posStart = useRef({ x: 0, y: 0 });
  const touchRef = useRef({
    initialDistance: 0,
    initialScale: 1,
    startX: 0,
    startY: 0,
    startPosX: 0,
    startPosY: 0,
    isSingleTouch: false,
  });

  const applyTransform = useCallback(() => {
    const image = imageRef.current;
    if (!image) return;
    image.style.transform = `translate3d(${posRef.current.x}px, ${posRef.current.y}px, 0) scale(${scaleRef.current})`;
  }, []);

  const scheduleTransform = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      applyTransform();
    });
  }, [applyTransform]);

  const setScale = useCallback((value: number | ((prev: number) => number)) => {
    setScaleState(prev => {
      const next = typeof value === 'function' ? value(prev) : value;
      scaleRef.current = next;
      scheduleTransform();
      return next;
    });
  }, [scheduleTransform]);

  const setPos = useCallback((value: { x: number; y: number }) => {
    posRef.current = value;
    scheduleTransform();
  }, [scheduleTransform]);

  const resetView = useCallback(() => { setScale(1); setPos({ x: 0, y: 0 }); }, [setScale, setPos]);
  const zoomIn = useCallback(() => setScale(p => Math.min(p + 0.5, 10)), [setScale]);
  const zoomOut = useCallback(() => setScale(p => { const n = p - 0.5; return n <= 1 ? 1 : n; }), [setScale]);
  const defaultActionPayload = useMemo<ImageActionPayload>(() => ({
    id: `random-${title || 'image'}-${instanceId}`,
    name: `${title || '随机图片'}-${instanceId}`,
    src,
    sourceKind: 'random',
    sourceLabel: title ? `随机图片：${title}` : '随机图片',
    sourceRef: src,
  }), [instanceId, src, title]);
  const resolvedActionPayload = actionPayload || defaultActionPayload;

  // Reset view when src changes (new image loaded)
  useEffect(() => { queueMicrotask(resetView); }, [src, resetView]);

  // 立即应用变换（切换图片时）
  useLayoutEffect(() => { applyTransform(); }, [applyTransform]);

  // Keyboard: Escape to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.deltaY < 0) zoomIn();
    else zoomOut();
  }, [zoomIn, zoomOut]);

  // Touch handlers (pinch-to-zoom + single-finger pan)
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      touchRef.current.initialDistance = getDistance(e.touches[0], e.touches[1]);
      touchRef.current.initialScale = scaleRef.current;
    } else if (e.touches.length === 1 && scaleRef.current > 1) {
      touchRef.current.isSingleTouch = true;
      touchRef.current.startX = e.touches[0].clientX;
      touchRef.current.startY = e.touches[0].clientY;
      touchRef.current.startPosX = posRef.current.x;
      touchRef.current.startPosY = posRef.current.y;
    }
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const ratio = getDistance(e.touches[0], e.touches[1]) / touchRef.current.initialDistance;
      setScale(Math.min(Math.max(touchRef.current.initialScale * ratio, 1), 10));
    } else if (e.touches.length === 1 && touchRef.current.isSingleTouch && scaleRef.current > 1) {
      e.preventDefault();
      setPos({
        x: touchRef.current.startPosX + (e.touches[0].clientX - touchRef.current.startX),
        y: touchRef.current.startPosY + (e.touches[0].clientY - touchRef.current.startY),
      });
    }
  }, [setScale, setPos]);

  const handleTouchEnd = useCallback(() => { touchRef.current.isSingleTouch = false; }, []);

  // Mouse drag
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY };
    posStart.current = { ...posRef.current };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    setPos({
      x: posStart.current.x + (e.clientX - dragStart.current.x),
      y: posStart.current.y + (e.clientY - dragStart.current.y),
    });
  }, [dragging, setPos]);

  const handleMouseUp = useCallback(() => setDragging(false), []);

  return (
    <div
      className="fixed inset-0 z-[9999] select-none bg-background/80 backdrop-blur-sm"
      style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, width: '100vw', height: '100vh' }}
      onWheel={handleWheel}
    >
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-20 flex h-12 items-center justify-between border-b border-border bg-background/95 backdrop-blur-sm px-4">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <div className="flex items-center gap-1">
          {canRefresh && (
            <Button variant="ghost" size="icon" onClick={onRefresh} title="换一张" disabled={loading}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={onClose} title="关闭">
            <X className="h-5 w-5" />
          </Button>
        </div>
      </div>

      {/* Zoom controls at bottom */}
      <div className="absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full bg-background/90 px-2 py-1.5 backdrop-blur-sm shadow-lg ring-1 ring-border">
        <button onClick={zoomOut} className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title="缩小">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3M8 11h6" /></svg>
        </button>
        <span className="min-w-[44px] text-center text-xs tabular-nums text-muted-foreground">{Math.round(scaleState * 100)}%</span>
        <button onClick={zoomIn} className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title="放大">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3M11 8v6M8 11h6" /></svg>
        </button>
        <div className="mx-1 h-4 w-px bg-border" />
        <button onClick={resetView} className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title="重置视图">
          <Maximize2 className="w-4 h-4" />
        </button>
        <div className="mx-1 h-4 w-px bg-border" />
        <button onClick={() => void runImageAction('download', resolvedActionPayload)} className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title="下载">
          <Download className="w-4 h-4" />
        </button>
        <button onClick={() => void runImageAction('copy', resolvedActionPayload)} className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title="复制图片">
          <Copy className="w-4 h-4" />
        </button>
        <button onClick={() => void runImageAction('add-to-assets', resolvedActionPayload)} className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title="添加到素材库">
          <ImagePlus className="w-4 h-4" />
        </button>
        <button onClick={() => void runImageAction('use-as-reference', resolvedActionPayload)} className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title="作为图生图参考">
          <Wand2 className="w-4 h-4" />
        </button>
      </div>

      {/* Image area with drag/pan */}
      <div
        className="absolute inset-0 pt-12 overflow-hidden"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{ cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
      >
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              <span className="text-sm">加载中...</span>
            </div>
          </div>
        )}
        {src && (
          <img
            ref={imageRef}
            src={src}
            alt={title}
            draggable={false}
            onLoad={onImageLoaded}
            onError={onImageError}
            className="h-full w-full origin-center object-contain will-change-transform"
            style={{ transition: dragging ? 'none' : 'transform 120ms ease-out' }}
          />
        )}
      </div>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronRight,
  Cloud,
  Download,
  Folder,
  FolderOpen,
  FolderPlus,
  ImageIcon,
  Loader2,
  RefreshCw,
  Search,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { formatAssetSize } from '@/lib/asset-store';
import type { S3Folder, S3ImageObject, S3PublicConfig } from '@/lib/desktop-bridge';
import {
  createS3Folder,
  downloadS3Object,
  getS3Config,
  getS3RootPrefix,
  listS3Folder,
  s3AssetSelection,
  getSelectionBlob,
  getSelectionThumbnailBlob,
  uploadFileToS3,
} from '@/lib/s3-assets';
import { dispatchImageActionToast, runImageAction } from '@/lib/image-actions';

interface S3AssetBrowserProps {
  mode?: 'workspace' | 'picker';
  selectedKeys?: ReadonlySet<string>;
  onToggleObject?: (object: S3ImageObject) => void;
  onPrefixChange?: (prefix: string) => void;
  onConfigure?: () => void;
  className?: string;
}

interface FolderPage {
  folders: S3Folder[];
  nextToken?: string;
  loading: boolean;
  loaded: boolean;
}

function mergeByKey<T>(items: T[], additions: T[], keyOf: (item: T) => string): T[] {
  const map = new Map(items.map(item => [keyOf(item), item]));
  for (const item of additions) map.set(keyOf(item), item);
  return Array.from(map.values());
}

function S3Thumbnail({ object }: { object: S3ImageObject }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    let objectUrl = '';
    void getSelectionThumbnailBlob(s3AssetSelection(object))
      .then(blob => {
        if (!blob || disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setFailed(false);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [object]);

  if (failed) return <ImageIcon className="h-7 w-7 text-muted-foreground/45" />;
  if (!url) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/60" />;
  return <img src={url} alt={object.name} className="h-full w-full object-cover" draggable={false} />;
}

function FolderTreeNode({
  folder,
  currentPrefix,
  onSelect,
}: {
  folder: S3Folder;
  currentPrefix: string;
  onSelect: (prefix: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState<FolderPage>({ folders: [], loading: false, loaded: false });

  const load = useCallback(async (continuationToken?: string) => {
    setPage(prev => ({ ...prev, loading: true }));
    try {
      const result = await listS3Folder(folder.prefix, continuationToken);
      setPage(prev => ({
        folders: continuationToken ? mergeByKey(prev.folders, result.folders, item => item.prefix) : result.folders,
        nextToken: result.nextToken,
        loading: false,
        loaded: true,
      }));
    } catch {
      setPage(prev => ({ ...prev, loading: false, loaded: true }));
    }
  }, [folder.prefix]);

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !page.loaded && !page.loading) void load();
  };

  const active = currentPrefix === folder.prefix;
  return (
    <div>
      <div className={cn('group flex h-8 items-center rounded-md text-xs', active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
        <button type="button" onClick={toggleExpanded} className="flex h-7 w-7 shrink-0 items-center justify-center" title={expanded ? '收起文件夹' : '展开文件夹'}>
          {page.loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-90')} />}
        </button>
        <button type="button" onClick={() => onSelect(folder.prefix)} className="flex min-w-0 flex-1 items-center gap-1.5 pr-2 text-left">
          {active ? <FolderOpen className="h-3.5 w-3.5 shrink-0" /> : <Folder className="h-3.5 w-3.5 shrink-0" />}
          <span className="truncate">{folder.name}</span>
        </button>
      </div>
      {expanded && (
        <div className="ml-3 border-l border-border/70 pl-1.5">
          {page.folders.map(child => <FolderTreeNode key={child.prefix} folder={child} currentPrefix={currentPrefix} onSelect={onSelect} />)}
          {page.nextToken && (
            <button type="button" disabled={page.loading} onClick={() => void load(page.nextToken)} className="h-7 px-2 text-[11px] text-primary hover:underline disabled:opacity-50">
              加载更多
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function S3AssetBrowser({
  mode = 'workspace',
  selectedKeys,
  onToggleObject,
  onPrefixChange,
  onConfigure,
  className,
}: S3AssetBrowserProps) {
  const [config, setConfig] = useState<S3PublicConfig | null>(null);
  const [configError, setConfigError] = useState('');
  const [currentPrefix, setCurrentPrefix] = useState('');
  const [rootPage, setRootPage] = useState<FolderPage>({ folders: [], loading: false, loaded: false });
  const [folders, setFolders] = useState<S3Folder[]>([]);
  const [objects, setObjects] = useState<S3ImageObject[]>([]);
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState('');
  const [previewObject, setPreviewObject] = useState<S3ImageObject | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [referenceLoadingKey, setReferenceLoadingKey] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);

  const configured = Boolean(config?.bucket && config.hasAccessKeyId && config.hasSecretAccessKey);
  const rootPrefix = config ? getS3RootPrefix(config) : '';

  useEffect(() => {
    let disposed = false;
    void getS3Config()
      .then(value => {
        if (disposed) return;
        setConfig(value);
        if (value) setCurrentPrefix(getS3RootPrefix(value));
      })
      .catch(error => {
        if (!disposed) setConfigError(error instanceof Error ? error.message : '读取 S3 配置失败');
      });
    return () => { disposed = true; };
  }, []);

  const loadFolder = useCallback(async (prefix: string, continuationToken?: string) => {
    const requestId = ++requestIdRef.current;
    if (continuationToken) setLoadingMore(true);
    else setLoading(true);
    try {
      const result = await listS3Folder(prefix, continuationToken);
      if (requestId !== requestIdRef.current) return;
      setCurrentPrefix(result.prefix);
      setFolders(prev => continuationToken ? mergeByKey(prev, result.folders, item => item.prefix) : result.folders);
      setObjects(prev => continuationToken ? mergeByKey(prev, result.objects, item => item.key) : result.objects);
      setNextToken(result.nextToken);
      onPrefixChange?.(result.prefix);
      if (result.prefix === rootPrefix && !continuationToken) {
        setRootPage({ folders: result.folders, nextToken: result.nextToken, loading: false, loaded: true });
      }
    } catch (error) {
      if (requestId === requestIdRef.current) {
        dispatchImageActionToast(error instanceof Error ? error.message : '读取 S3 文件夹失败', 'error');
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [onPrefixChange, rootPrefix]);

  useEffect(() => {
    if (!configured) return;
    const timer = window.setTimeout(() => void loadFolder(rootPrefix), 0);
    return () => window.clearTimeout(timer);
  }, [configured, loadFolder, rootPrefix]);

  const openPrefix = useCallback((prefix: string) => {
    setQuery('');
    setFolders([]);
    setObjects([]);
    setNextToken(undefined);
    void loadFolder(prefix);
  }, [loadFolder]);

  const loadMoreRootFolders = useCallback(async () => {
    if (!rootPage.nextToken || rootPage.loading) return;
    setRootPage(prev => ({ ...prev, loading: true }));
    try {
      const result = await listS3Folder(rootPrefix, rootPage.nextToken);
      setRootPage(prev => ({
        folders: mergeByKey(prev.folders, result.folders, item => item.prefix),
        nextToken: result.nextToken,
        loading: false,
        loaded: true,
      }));
    } catch {
      setRootPage(prev => ({ ...prev, loading: false }));
    }
  }, [rootPage.loading, rootPage.nextToken, rootPrefix]);

  const breadcrumbs = useMemo(() => {
    const relative = currentPrefix.slice(rootPrefix.length).replace(/\/$/, '');
    const segments = relative ? relative.split('/') : [];
    const items = [{ label: config?.bucket || 'S3', prefix: rootPrefix }];
    let prefix = rootPrefix;
    for (const segment of segments) {
      prefix += `${segment}/`;
      items.push({ label: segment, prefix });
    }
    return items;
  }, [config?.bucket, currentPrefix, rootPrefix]);

  const filteredObjects = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? objects.filter(object => object.name.toLowerCase().includes(normalized)) : objects;
  }, [objects, query]);
  const hasQuery = query.trim().length > 0;

  const openPreview = useCallback((object: S3ImageObject) => {
    setPreviewObject(object);
    setPreviewLoading(true);
    void getSelectionBlob(s3AssetSelection(object))
      .then(blob => {
        if (!blob) throw new Error('S3 图片读取失败');
        setPreviewUrl(URL.createObjectURL(blob));
      })
      .catch(error => {
        setPreviewObject(null);
        dispatchImageActionToast(error instanceof Error ? error.message : 'S3 图片读取失败', 'error');
      })
      .finally(() => setPreviewLoading(false));
  }, []);

  const closePreview = useCallback(() => {
    setPreviewObject(null);
    setPreviewUrl(current => {
      if (current) URL.revokeObjectURL(current);
      return '';
    });
  }, []);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const handleUpload = useCallback(async (files: FileList | File[]) => {
    const queue = Array.from(files);
    if (!queue.length) return;
    setUploading(true);
    let index = 0;
    let uploaded = 0;
    const errors: string[] = [];
    const worker = async () => {
      while (index < queue.length) {
        const file = queue[index++];
        try {
          await uploadFileToS3(currentPrefix, file, file.name);
          uploaded += 1;
        } catch (error) {
          errors.push(error instanceof Error ? error.message : `${file.name} 上传失败`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, () => worker()));
    setUploading(false);
    if (uploaded) {
      dispatchImageActionToast(`已上传 ${uploaded} 张图片到 S3`, 'success');
      await loadFolder(currentPrefix);
    }
    if (errors.length) dispatchImageActionToast(errors[0], 'error');
  }, [currentPrefix, loadFolder]);

  const handleCreateFolder = useCallback(async () => {
    if (!folderName.trim()) return;
    setCreatingFolder(true);
    try {
      await createS3Folder(currentPrefix, folderName);
      setFolderDialogOpen(false);
      setFolderName('');
      await loadFolder(currentPrefix);
      dispatchImageActionToast('S3 文件夹已创建', 'success');
    } catch (error) {
      dispatchImageActionToast(error instanceof Error ? error.message : '创建 S3 文件夹失败', 'error');
    } finally {
      setCreatingFolder(false);
    }
  }, [currentPrefix, folderName, loadFolder]);

  const handleDownload = useCallback(async (object: S3ImageObject) => {
    try {
      const result = await downloadS3Object(object);
      if (!result.canceled) dispatchImageActionToast('S3 图片已下载', 'success');
    } catch (error) {
      dispatchImageActionToast(error instanceof Error ? error.message : '下载 S3 图片失败', 'error');
    }
  }, []);

  const handleUseAsReference = useCallback(async (object: S3ImageObject) => {
    setReferenceLoadingKey(object.key);
    try {
      const blob = await getSelectionBlob(s3AssetSelection(object));
      if (!blob) throw new Error('S3 图片读取失败');
      await runImageAction('use-as-reference', {
        id: `s3:${object.key}`,
        name: object.name,
        blob,
        mimeType: object.mimeType,
        sourceKind: 'manual',
        sourceLabel: 'S3 存储',
        sourceRef: object.key,
      });
    } catch (error) {
      dispatchImageActionToast(error instanceof Error ? error.message : '添加图生图参考失败', 'error');
    } finally {
      setReferenceLoadingKey('');
    }
  }, []);

  if (!config && !configError) {
    return <div className={cn('flex min-h-56 items-center justify-center', className)}><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  if (!config || !configured) {
    return (
      <div className={cn('flex min-h-56 flex-col items-center justify-center gap-3 px-6 text-center', className)}>
        <div className="flex h-11 w-11 items-center justify-center rounded-md border bg-muted/40"><Cloud className="h-5 w-5 text-muted-foreground" /></div>
        <div>
          <p className="text-sm font-medium">尚未配置 S3 素材源</p>
          <p className="mt-1 text-xs text-muted-foreground">请在桌面端设置中填写存储桶和访问凭据。</p>
        </div>
        {onConfigure && <Button size="sm" variant="outline" onClick={onConfigure}>打开设置</Button>}
      </div>
    );
  }

  return (
    <div className={cn('flex min-h-0 flex-1 overflow-hidden border bg-background', mode === 'workspace' ? 'rounded-md' : 'rounded-md', className)}>
      <aside className={cn('hidden shrink-0 flex-col border-r bg-muted/20 md:flex', mode === 'picker' ? 'w-44' : 'w-56')}>
        <div className="flex h-10 items-center gap-2 border-b px-3 text-xs font-medium text-foreground">
          <Cloud className="h-3.5 w-3.5 text-primary" />
          <span className="truncate">{config.bucket}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <button
            type="button"
            onClick={() => openPrefix(rootPrefix)}
            className={cn('mb-1 flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-xs', currentPrefix === rootPrefix ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}
          >
            {currentPrefix === rootPrefix ? <FolderOpen className="h-3.5 w-3.5" /> : <Folder className="h-3.5 w-3.5" />}
            <span className="truncate">{config.rootPrefix || '存储桶根目录'}</span>
          </button>
          {rootPage.folders.map(folder => <FolderTreeNode key={folder.prefix} folder={folder} currentPrefix={currentPrefix} onSelect={openPrefix} />)}
          {rootPage.nextToken && (
            <button type="button" disabled={rootPage.loading} onClick={() => void loadMoreRootFolders()} className="h-7 px-2 text-[11px] text-primary hover:underline disabled:opacity-50">
              {rootPage.loading ? '加载中...' : '加载更多目录'}
            </button>
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-11 flex-wrap items-center gap-2 border-b px-2.5 py-1.5">
          <div className="flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap text-xs text-muted-foreground">
            {breadcrumbs.map((item, index) => (
              <div key={item.prefix || 'root'} className="flex items-center">
                {index > 0 && <ChevronRight className="mx-0.5 h-3 w-3 shrink-0 opacity-50" />}
                <button type="button" onClick={() => openPrefix(item.prefix)} className={cn('max-w-40 truncate rounded px-1.5 py-1 hover:bg-muted hover:text-foreground', index === breadcrumbs.length - 1 && 'font-medium text-foreground')}>
                  {item.label}
                </button>
              </div>
            ))}
          </div>
          <div className="relative w-44 shrink-0">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索当前目录" className="h-8 w-full rounded-md border bg-background pl-7 pr-7 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30" />
            {query && <button type="button" onClick={() => setQuery('')} title="清空搜索" className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>}
          </div>
          <Button variant="ghost" size="icon-sm" title="刷新当前文件夹" disabled={loading} onClick={() => void loadFolder(currentPrefix)}><RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /></Button>
          {mode === 'workspace' && (
            <>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setFolderDialogOpen(true)}><FolderPlus className="h-3.5 w-3.5" />新建文件夹</Button>
              <Button size="sm" className="gap-1.5" disabled={uploading} onClick={() => fileInputRef.current?.click()}>{uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}上传</Button>
              <input ref={fileInputRef} hidden type="file" multiple accept=".png,.jpg,.jpeg,.webp,.gif,.avif" onChange={event => { if (event.target.files) void handleUpload(event.target.files); event.target.value = ''; }} />
            </>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="flex min-h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : (hasQuery ? filteredObjects.length === 0 : folders.length === 0 && filteredObjects.length === 0) ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
              <FolderOpen className="h-8 w-8 opacity-40" />
              <p className="text-sm">{hasQuery ? '当前目录没有匹配的图片' : '当前文件夹暂无图片'}</p>
            </div>
          ) : (
            <>
              {folders.length > 0 && !hasQuery && (
                <div className="mb-3 grid grid-cols-2 gap-2 lg:grid-cols-3 xl:grid-cols-4">
                  {folders.map(folder => (
                    <button key={folder.prefix} type="button" onClick={() => openPrefix(folder.prefix)} className="flex h-10 min-w-0 items-center gap-2 rounded-md border bg-card px-2.5 text-left text-xs transition-colors hover:border-primary/40 hover:bg-muted/40">
                      <Folder className="h-4 w-4 shrink-0 text-amber-500" /><span className="truncate">{folder.name}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className={cn('grid gap-2.5', mode === 'picker' ? 'grid-cols-2 lg:grid-cols-3 xl:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6')}>
                {filteredObjects.map(object => {
                  const selected = selectedKeys?.has(object.key) || false;
                  return (
                    <div key={object.key} className={cn('group overflow-hidden rounded-md border bg-card transition-colors', selected ? 'border-primary ring-1 ring-primary/30' : 'hover:border-muted-foreground/35')}>
                      <div className="relative flex aspect-square w-full items-center justify-center overflow-hidden bg-muted/50 text-left">
                        <S3Thumbnail object={object} />
                        <button type="button" aria-label={mode === 'picker' ? `选择 ${object.name}` : `预览 ${object.name}`} onClick={() => mode === 'picker' ? onToggleObject?.(object) : openPreview(object)} className="absolute inset-0 z-10" />
                        {mode === 'picker' && (
                          <span className={cn('pointer-events-none absolute right-1.5 top-1.5 z-20 flex h-5 w-5 items-center justify-center rounded-full border shadow-sm', selected ? 'border-primary bg-primary text-primary-foreground' : 'border-white/70 bg-black/35 text-white')}>
                            {selected && <Check className="h-3 w-3" />}
                          </span>
                        )}
                        {mode === 'workspace' && (
                          <div className="absolute right-1.5 top-1.5 z-20 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                            <button type="button" title="作为图生图参考" disabled={Boolean(referenceLoadingKey)} onClick={() => void handleUseAsReference(object)} className="flex h-7 w-7 items-center justify-center rounded-md bg-black/55 text-white shadow-sm hover:bg-black/75 disabled:cursor-wait disabled:opacity-60">
                              {referenceLoadingKey === object.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                            </button>
                            <button type="button" title="下载到电脑" onClick={() => void handleDownload(object)} className="flex h-7 w-7 items-center justify-center rounded-md bg-black/55 text-white shadow-sm hover:bg-black/75">
                              <Download className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 p-2">
                        <p className="truncate text-xs font-medium" title={object.name}>{object.name}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">{formatAssetSize(object.sizeBytes)}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
              {nextToken && !hasQuery && (
                <div className="flex justify-center pt-4">
                  <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadFolder(currentPrefix, nextToken)}>
                    {loadingMore && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}加载更多
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>新建 S3 文件夹</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">创建位置：{currentPrefix || '存储桶根目录'}</div>
            <Input autoFocus value={folderName} onChange={event => setFolderName(event.target.value)} placeholder="文件夹名称" onKeyDown={event => { if (event.key === 'Enter') void handleCreateFolder(); }} />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setFolderDialogOpen(false)}>取消</Button>
              <Button disabled={!folderName.trim() || creatingFolder} onClick={() => void handleCreateFolder()}>{creatingFolder && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}创建</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(previewObject)} onOpenChange={open => { if (!open) closePreview(); }}>
        <DialogContent className="flex max-h-[92dvh] max-w-6xl flex-col overflow-hidden p-0">
          <DialogHeader className="border-b px-4 py-3"><DialogTitle className="truncate text-sm">{previewObject?.name}</DialogTitle></DialogHeader>
          <div className="flex min-h-[50dvh] items-center justify-center overflow-auto bg-black/95 p-4">
            {previewLoading ? <Loader2 className="h-6 w-6 animate-spin text-white/70" /> : previewUrl ? <img src={previewUrl} alt={previewObject?.name || 'S3 图片'} className="max-h-[72dvh] max-w-full object-contain" /> : null}
          </div>
          {previewObject && <div className="flex items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground"><span>{formatAssetSize(previewObject.sizeBytes)}</span><Button size="sm" variant="outline" className="gap-1.5" onClick={() => void handleDownload(previewObject)}><Download className="h-3.5 w-3.5" />下载到电脑</Button></div>}
        </DialogContent>
      </Dialog>
    </div>
  );
}

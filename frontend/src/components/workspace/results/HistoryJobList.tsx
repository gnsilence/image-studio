'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertCircle, CalendarDays, ChevronDown, ImagePlus, Loader2, RefreshCw, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { Mode, StoredJob } from '@/lib/job-store';
import { cn } from '@/lib/utils';
import { getModelDisplayName } from '@/lib/model-capabilities';
import { CompletedJobCard } from '@/components/workspace/results/CompletedJobCard';
import type { CanvasTaskImportRequest } from '@/components/canvas/canvas-job-import';

export type GenerationHistoryFilter = 'all' | 'text-to-image' | 'image-to-image';
export type HistoryClearScope = GenerationHistoryFilter;

const historyFilterOptions: { value: GenerationHistoryFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'text-to-image', label: '文生图' },
  { value: 'image-to-image', label: '图生图' },
];

export function isWaitingJob(job: StoredJob): boolean {
  return job.status === 'processing' || job.status === 'queued' || job.status === '排队中';
}

export function getHistoryColumnCount(width: number): number {
  return width >= 760 ? 3 : width >= 500 ? 2 : 1;
}

export function formatElapsedTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分${String(seconds % 60).padStart(2, '0')}秒`;
  return `${Math.floor(minutes / 60)}时${String(minutes % 60).padStart(2, '0')}分`;
}

export interface JobDayGroup {
  key: string;
  label: string;
  jobs: StoredJob[];
}

function normalizeSearchValue(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function filterHistoryJobs(jobs: StoredJob[], searchValue: string): StoredJob[] {
  const normalizedSearch = normalizeSearchValue(searchValue);
  if (!normalizedSearch) return jobs;
  return jobs.filter(job => (
    job.prompt.toLocaleLowerCase().includes(normalizedSearch)
    || getModelDisplayName(job.model).toLocaleLowerCase().includes(normalizedSearch)
  ));
}

export function groupJobsByDay(jobs: StoredJob[]): JobDayGroup[] {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const getDayKey = (date: Date) => [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
    .join('-');
  const todayKey = getDayKey(today);
  const yesterdayKey = getDayKey(yesterday);
  const groups: JobDayGroup[] = [];

  jobs.forEach((job) => {
    const date = new Date(job.created_at);
    const validDate = !Number.isNaN(date.getTime());
    const key = validDate ? getDayKey(date) : 'unknown';
    const label = !validDate
      ? '较早记录'
      : key === todayKey
        ? '今天'
        : key === yesterdayKey
          ? '昨天'
          : new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(date);
    const currentGroup = groups.at(-1);
    if (!currentGroup || currentGroup.key !== key) groups.push({ key, label, jobs: [job] });
    else currentGroup.jobs.push(job);
  });

  return groups;
}

function useNow(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);

  return now;
}

function DayIndex({
  groups,
  selectedDayKey,
  onSelectDay,
}: {
  groups: JobDayGroup[];
  selectedDayKey: string | undefined;
  onSelectDay: (key: string) => void;
}) {
  const selectedGroup = groups.find(group => group.key === selectedDayKey) || groups[0];
  const trigger = (
    <Button
      variant="outline"
      size="sm"
      disabled={!selectedGroup}
      className="h-8 w-36 shrink-0 justify-between gap-1.5 rounded-lg px-2.5 text-xs"
      title={selectedGroup ? '按日期定位' : '暂无可定位的日期'}
    >
      <CalendarDays className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left">{selectedGroup?.label || '暂无日期'}</span>
      <span className="shrink-0 text-muted-foreground">{selectedGroup?.jobs.length || 0}</span>
      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
    </Button>
  );

  if (!selectedGroup) return trigger;

  return (
    <Popover>
      <PopoverTrigger asChild>
        {trigger}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1.5">
        <div className="max-h-72 overflow-y-auto">
          {groups.map(group => (
            <button
              key={group.key}
              type="button"
              onClick={() => onSelectDay(group.key)}
              className={cn(
                'flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-xs transition-colors',
                group.key === selectedGroup.key
                  ? 'bg-primary/10 text-primary'
                  : 'text-foreground hover:bg-muted'
              )}
            >
              <span>{group.label}</span>
              <span className="text-muted-foreground">{group.jobs.length} 项</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const WaitingJobCard = memo(function WaitingJobCard({
  job,
  now,
  isChecking,
  cooldownEnd,
  onCancel,
  onCheckStatus,
  compact = false,
}: {
  job: StoredJob;
  now: number;
  isChecking: boolean;
  cooldownEnd: number | undefined;
  onCancel: (jobId: string) => void;
  onCheckStatus: (job: StoredJob) => void;
  compact?: boolean;
}) {
  const parallelCount = job.parallelCount || 1;
  const statusText = job.status === 'queued' || job.status === '排队中'
    ? '排队中'
    : job.mode === 'text-to-image'
      ? (parallelCount > 1 ? `生成中 x${parallelCount}` : '生成中')
      : (parallelCount > 1 ? `转换中 x${parallelCount}` : '转换中');
  const createdAt = Date.parse(job.created_at);
  const elapsedSeconds = Number.isFinite(createdAt) ? Math.max(0, Math.floor((now - createdAt) / 1000)) : 0;

  return (
    <div className={cn('studio-waiting-card h-full overflow-hidden border border-border bg-card', compact ? 'rounded-lg' : 'rounded-xl')}>
      <div className={cn('flex gap-3', compact ? 'p-3' : 'p-4')}>
        <div className={cn(
          'studio-waiting-art relative flex flex-shrink-0 items-center justify-center overflow-hidden border border-processing/20 bg-processing/10',
          compact ? 'h-12 w-12 rounded-md' : 'h-16 w-16 rounded-lg'
        )}>
          <div className="relative z-10 flex h-8 w-8 items-center justify-center rounded-md bg-card/75">
            <Loader2 className="w-4 h-4 animate-spin text-processing" />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded-md bg-processing/10 px-1.5 py-0.5 text-[11px] font-medium text-processing">{statusText}</span>
            <span className="truncate text-xs text-muted-foreground" title={getModelDisplayName(job.model)}>{getModelDisplayName(job.model)}</span>
          </div>
          <p className={cn('truncate text-sm text-foreground', compact ? 'mt-1.5' : 'mt-2')}>&quot;{job.prompt}&quot;</p>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-processing" />
            已用 <span className="font-mono text-foreground">{formatElapsedTime(elapsedSeconds)}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-start gap-1">
          {job.serverTaskId && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onCheckStatus(job)}
              disabled={isChecking || (cooldownEnd !== undefined && now < cooldownEnd)}
              title="查看进度"
            >
              {isChecking
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <RefreshCw className="w-4 h-4" />}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onCancel(job.id)}
            title="取消"
            className="text-muted-foreground hover:text-destructive"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
});

export function ActiveJobList({
  jobs,
  checkingJobIds,
  cooldowns,
  onCancel,
  onCheckStatus,
}: {
  jobs: StoredJob[];
  checkingJobIds: Set<string>;
  cooldowns: Map<string, number>;
  onCancel: (jobId: string) => void;
  onCheckStatus: (job: StoredJob) => void;
}) {
  const hasActiveTimers = jobs.length > 0;
  const now = useNow(hasActiveTimers);

  return (
    <section className="nova-studio-panel flex min-h-[136px] max-h-[28vh] min-w-0 flex-col overflow-hidden rounded-xl border border-processing/20 bg-processing/[0.03] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">进行中任务</h3>
          <p className="text-[11px] text-muted-foreground">{jobs.length > 0 ? `${jobs.length} 项正在处理` : '暂无进行中的任务'}</p>
        </div>
        <Loader2 className={cn('size-4 text-processing', jobs.length > 0 && 'animate-spin')} />
      </div>
      {jobs.length > 0 ? (
        <div className="min-h-0 space-y-2 overflow-y-auto pr-1">
          {jobs.map(job => (
            <WaitingJobCard
              key={job.id}
              job={job}
              now={now}
              compact
              isChecking={checkingJobIds.has(job.id)}
              cooldownEnd={cooldowns.get(job.id)}
              onCancel={onCancel}
              onCheckStatus={onCheckStatus}
            />
          ))}
        </div>
      ) : (
        <div className="studio-active-empty relative flex min-h-0 flex-1 items-center justify-center overflow-hidden text-xs text-muted-foreground">
          <span className="relative z-10">提交后的任务会显示在这里</span>
        </div>
      )}
    </section>
  );
}

function JobsHeader({
  title,
  jobsList,
  groups,
  searchValue,
  onSearchChange,
  selectedDayKey,
  onSelectDay,
  filter,
  onFilterChange,
  onClearAll,
}: {
  title: string;
  jobsList: StoredJob[];
  groups: JobDayGroup[];
  searchValue: string;
  onSearchChange: (value: string) => void;
  selectedDayKey: string | undefined;
  onSelectDay: (key: string) => void;
  filter?: GenerationHistoryFilter;
  onFilterChange?: (filter: GenerationHistoryFilter) => void;
  onClearAll: () => void;
}) {
  const completed = jobsList.filter(job => job.status === 'completed').length;
  const queued = jobsList.filter(job => job.status === 'queued' || job.status === '排队中').length;
  const processing = jobsList.filter(job => job.status === 'processing').length;

  return (
    <div className="studio-history-header flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground">
          共 {jobsList.length} 条 · 完成 {completed} · 处理中 {processing} · 排队 {queued}
        </p>
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
        <div className="relative w-64 max-w-full min-w-44 shrink-0">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchValue}
            onChange={event => onSearchChange(event.target.value)}
            placeholder="搜索提示词或模型"
            aria-label="搜索提示词或模型"
            className="h-8 rounded-lg pl-8 pr-8 text-xs"
          />
          {searchValue && (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              title="清除搜索"
              aria-label="清除搜索"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <DayIndex groups={groups} selectedDayKey={selectedDayKey} onSelectDay={onSelectDay} />
        {filter && onFilterChange && (
          <div className="flex rounded-lg border border-border bg-muted/45 p-0.5">
            {historyFilterOptions.map(option => (
              <button
                key={option.value}
                type="button"
                onClick={() => onFilterChange(option.value)}
                className={cn(
                    'h-7 rounded-md px-2.5 text-xs transition-colors',
                  filter === option.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
        <Button variant="ghost" size="sm" onClick={onClearAll} disabled={jobsList.length === 0}>
          清空记录
        </Button>
      </div>
    </div>
  );
}

function useColumnCount(
  ref: React.RefObject<HTMLDivElement | null>,
  wideMode: boolean,
  ready: boolean,
) {
  const [columns, setColumns] = useState(() => (wideMode && ready ? 3 : 1));

  useEffect(() => {
    if (!wideMode || !ready) {
      queueMicrotask(() => setColumns(1));
      return;
    }
    const el = ref.current;
    if (!el) return;

    const compute = () => {
      const width = el.clientWidth;
      setColumns(getHistoryColumnCount(width));
    };

    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, wideMode, ready]);

  return wideMode ? columns : 1;
}

function VirtualJobList({
  groups,
  active,
  wideMode,
  renderJobCard,
  scrollToDayKey,
  onScrollToDayComplete,
  onVisibleDayChange,
}: {
  groups: JobDayGroup[];
  active: boolean;
  wideMode: boolean;
  renderJobCard: (job: StoredJob) => React.ReactNode;
  scrollToDayKey?: string;
  onScrollToDayComplete: () => void;
  onVisibleDayChange: (key: string | undefined) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const shouldRender = active && groups.length > 0;
  const columns = useColumnCount(parentRef, wideMode, shouldRender);
  const jobCount = useMemo(() => groups.reduce((total, group) => total + group.jobs.length, 0), [groups]);

  const virtualizer = useVirtualizer({
    count: active ? groups.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 420,
    overscan: 5,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const visibleDayKey = virtualItems.length > 0 ? groups[virtualItems[0].index]?.key : undefined;

  useEffect(() => {
    onVisibleDayChange(visibleDayKey);
  }, [onVisibleDayChange, visibleDayKey]);

  useEffect(() => {
    if (!scrollToDayKey) return;
    const groupIndex = groups.findIndex(group => group.key === scrollToDayKey);
    if (groupIndex < 0) return;
    virtualizer.scrollToIndex(groupIndex, { align: 'start' });
    onScrollToDayComplete();
  }, [groups, onScrollToDayComplete, scrollToDayKey, virtualizer]);

  if (!shouldRender) return null;

  return (
    <div
      ref={parentRef}
      className={cn('studio-history-list relative virtual-scroll-container', wideMode && 'studio-history-list-wide min-h-0 flex-1')}
      style={{
        height: wideMode ? undefined : (jobCount > 3 ? '70vh' : 'auto'),
        maxHeight: wideMode ? undefined : '70vh',
        minHeight: jobCount > 0 ? '200px' : '0',
        overflow: 'auto',
        overflowX: 'hidden',
      }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualItems.map(virtualRow => {
          const group = groups[virtualRow.index];
          return (
            <div
              key={group.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 w-full"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <section className="studio-history-day-group pb-4">
                <div className="studio-history-day-divider mb-2.5 flex items-center gap-3">
                  <span className="text-xs font-medium text-foreground">{group.label}</span>
                  <span className="text-[11px] text-muted-foreground">{group.jobs.length} 项</span>
                  <span className="h-px flex-1 bg-border/70" />
                </div>
                <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
                  {group.jobs.map((job) => (
                    <div key={job.id} className="studio-history-job">
                      {renderJobCard(job)}
                    </div>
                  ))}
                </div>
              </section>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface HistoryJobListProps {
  active: boolean;
  wideMode?: boolean;
  title: string;
  mode: Mode;
  historyFilter?: GenerationHistoryFilter;
  emptyDescription?: string;
  jobs: StoredJob[];
  loadedImages: Set<string>;
  checkingJobIds: Set<string>;
  cooldowns: Map<string, number>;
  onRetry: (job: StoredJob) => void;
  onClear: (jobId: string) => void;
  onClearAll: (scope: HistoryClearScope) => void;
  onHistoryFilterChange?: (filter: GenerationHistoryFilter) => void;
  onCancel: (jobId: string) => void;
  onCheckStatus: (job: StoredJob) => void;
  onImportToCanvas: (request: CanvasTaskImportRequest) => void;
}

export function HistoryJobList({
  active,
  wideMode = false,
  title,
  mode,
  historyFilter,
  emptyDescription,
  jobs,
  loadedImages,
  checkingJobIds,
  cooldowns,
  onRetry,
  onClear,
  onClearAll,
  onHistoryFilterChange,
  onCancel,
  onCheckStatus,
  onImportToCanvas,
}: HistoryJobListProps) {
  const hasActiveTimers = useMemo(() => active && jobs.some(job => isWaitingJob(job)), [active, jobs]);
  const now = useNow(hasActiveTimers);
  const clearScope: HistoryClearScope = historyFilter || (mode === 'image-to-image' ? 'image-to-image' : 'text-to-image');
  const [searchValue, setSearchValue] = useState('');
  const [selectedDayKey, setSelectedDayKey] = useState<string>();
  const [scrollToDayKey, setScrollToDayKey] = useState<string>();
  const normalizedSearch = normalizeSearchValue(searchValue);
  const filteredJobs = useMemo(() => filterHistoryJobs(jobs, normalizedSearch), [jobs, normalizedSearch]);
  const jobGroups = useMemo(() => groupJobsByDay(filteredJobs), [filteredJobs]);

  const handleSelectDay = useCallback((key: string) => {
    setSelectedDayKey(key);
    setScrollToDayKey(key);
  }, []);
  const handleVisibleDayChange = useCallback((key: string | undefined) => {
    if (key) setSelectedDayKey(key);
  }, []);
  const handleScrollToDayComplete = useCallback(() => {
    setScrollToDayKey(undefined);
  }, []);
  const effectiveScrollToDayKey = scrollToDayKey && jobGroups.some(group => group.key === scrollToDayKey)
    ? scrollToDayKey
    : undefined;

  const renderJobCard = (job: StoredJob) => {
    const hasImage = job.status === 'completed' && (job.images || job.imageData) && loadedImages.has(job.id);
    if (isWaitingJob(job)) {
      return <WaitingJobCard job={job} now={now} isChecking={checkingJobIds.has(job.id)} cooldownEnd={cooldowns.get(job.id)} onCancel={onCancel} onCheckStatus={onCheckStatus} />;
    }
    if (hasImage) {
      return <CompletedJobCard job={job} onClear={() => onClear(job.id)} onRetry={onRetry} onImportToCanvas={onImportToCanvas} />;
    }
    if (job.status === 'failed') {
      // terminal=true → 后端明确判定不可恢复，不显示"查看进度"
      // 其他情况（默认 / 网络错误 / 未分类）都允许"查看进度"，让用户兜底
      const allowCheckStatus = !job.terminal && !!job.serverTaskId;
      return (
        <div className="studio-failed-card h-full rounded-xl border border-destructive/20 bg-card p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-destructive/10 text-destructive">
                <AlertCircle className="size-4" />
              </div>
              <div className="min-w-0 space-y-1">
                <p className="truncate text-sm text-foreground">&quot;{job.prompt}&quot;</p>
                <p className="line-clamp-3 text-xs leading-5 text-destructive" title={job.error || '任务失败'}>{job.error || '任务失败'}</p>
                <p className="truncate text-xs text-muted-foreground" title={getModelDisplayName(job.model)}>{getModelDisplayName(job.model)}</p>
              </div>
            </div>
            <div className="flex gap-1">
              {allowCheckStatus && (
                <Button variant="ghost" size="icon-sm" onClick={() => onCheckStatus(job)} disabled={checkingJobIds.has(job.id) || (cooldowns.get(job.id) !== undefined && now < cooldowns.get(job.id)!)} title="查看进度">
                  {checkingJobIds.has(job.id)
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <RefreshCw className="w-4 h-4" />}
                </Button>
              )}
              <Button variant="ghost" size="icon-sm" onClick={() => onRetry(job)} title="重试">
                <RefreshCw className="w-4 h-4" />
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => onClear(job.id)} title="删除">
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <section className={cn(wideMode ? 'nova-studio-history-panel flex h-full min-h-0 flex-col space-y-3 p-4' : 'space-y-3')}>
      <JobsHeader
        title={title}
        jobsList={filteredJobs}
        groups={jobGroups}
        searchValue={searchValue}
        onSearchChange={setSearchValue}
        selectedDayKey={selectedDayKey}
        onSelectDay={handleSelectDay}
        filter={historyFilter}
        onFilterChange={onHistoryFilterChange}
        onClearAll={() => onClearAll(clearScope)}
      />
      {active && filteredJobs.length === 0 ? (
        <div className={cn(
          'studio-history-empty flex flex-col items-center justify-center text-center text-muted-foreground',
          wideMode ? 'flex-1 py-16' : 'py-6'
        )}>
          <div className="mb-3 flex size-10 items-center justify-center rounded-lg border border-border bg-muted/55 text-primary">
            <ImagePlus className="size-5" />
          </div>
          <p className="text-sm font-medium text-foreground">{searchValue ? '没有匹配任务' : '还没有作品'}</p>
          <p className="mt-1 max-w-64 text-xs leading-5 opacity-80">
            {searchValue ? '尝试更换提示词或模型名称' : (emptyDescription || (mode === 'text-to-image' ? '提交一段文字描述来生成图片' : '上传图片并输入描述来转换'))}
          </p>
        </div>
      ) : (
        <VirtualJobList
          groups={jobGroups}
          active={active}
          wideMode={wideMode}
          renderJobCard={renderJobCard}
          scrollToDayKey={effectiveScrollToDayKey}
          onScrollToDayComplete={handleScrollToDayComplete}
          onVisibleDayChange={handleVisibleDayChange}
        />
      )}
    </section>
  );
}

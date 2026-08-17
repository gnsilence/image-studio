import { describe, expect, it } from 'vitest';
import type { StoredJob } from '@/lib/job-store';
import { filterHistoryJobs, formatElapsedTime, getHistoryColumnCount, groupJobsByDay, isWaitingJob } from '@/components/workspace/results/HistoryJobList';

function makeJob(overrides: Partial<StoredJob> = {}): StoredJob {
  return {
    id: 'job-1',
    status: 'completed',
    mode: 'text-to-image',
    prompt: '城市夜景',
    output_size: '1K',
    temperature: 0.7,
    aspect_ratio: '1:1',
    model: 'test-model',
    created_at: '2026-08-14T12:00:00',
    ...overrides,
  };
}

describe('HistoryJobList helpers', () => {
  it('filters history jobs by prompt and model name', () => {
    const jobs = [
      makeJob({ id: 'prompt-match', prompt: '森林中的小屋' }),
      makeJob({ id: 'model-match', prompt: '海边日落', model: 'custom-model' }),
      makeJob({ id: 'other', prompt: '城市夜景', model: 'other-model' }),
    ];

    expect(filterHistoryJobs(jobs, '森林')).toEqual([jobs[0]]);
    expect(filterHistoryJobs(jobs, 'CUSTOM-MODEL')).toEqual([jobs[1]]);
    expect(filterHistoryJobs(jobs, '  ')).toEqual(jobs);
  });

  it('groups local calendar days and keeps daily counts', () => {
    const jobs = [
      makeJob({ id: 'today-1' }),
      makeJob({ id: 'today-2' }),
      makeJob({ id: 'older', created_at: '2026-08-13T12:00:00' }),
    ];

    expect(groupJobsByDay(jobs).map(group => ({ key: group.key, count: group.jobs.length }))).toEqual([
      { key: '2026-08-14', count: 2 },
      { key: '2026-08-13', count: 1 },
    ]);
  });

  it('recognizes queued and processing jobs as active', () => {
    expect(isWaitingJob(makeJob({ status: 'queued' }))).toBe(true);
    expect(isWaitingJob(makeJob({ status: '排队中' }))).toBe(true);
    expect(isWaitingJob(makeJob({ status: 'processing' }))).toBe(true);
    expect(isWaitingJob(makeJob({ status: 'completed' }))).toBe(false);
    expect(isWaitingJob(makeJob({ status: 'failed' }))).toBe(false);
  });

  it('uses compact responsive history columns', () => {
    expect(getHistoryColumnCount(499)).toBe(1);
    expect(getHistoryColumnCount(500)).toBe(2);
    expect(getHistoryColumnCount(759)).toBe(2);
    expect(getHistoryColumnCount(760)).toBe(3);
  });

  it('formats active task elapsed time compactly', () => {
    expect(formatElapsedTime(8)).toBe('8秒');
    expect(formatElapsedTime(68)).toBe('1分08秒');
    expect(formatElapsedTime(3730)).toBe('1时02分');
  });
});

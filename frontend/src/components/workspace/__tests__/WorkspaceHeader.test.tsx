import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceHeader, type WorkspaceHeaderRef } from '../WorkspaceHeader';

const { runImageActionMock } = vi.hoisted(() => ({
  runImageActionMock: vi.fn(),
}));

vi.mock('@/lib/image-actions', () => ({
  runImageAction: runImageActionMock,
}));

describe('WorkspaceHeader random image viewer', () => {
  beforeEach(() => {
    runImageActionMock.mockReset();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      new Blob(['current-image'], { type: 'image/jpeg' }),
      { status: 200, headers: { 'Content-Type': 'image/jpeg' } },
    )));
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:visible-image'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reuses the displayed image blob for asset and reference actions', async () => {
    const ref = createRef<WorkspaceHeaderRef>();
    const { unmount } = render(
      <WorkspaceHeader
        ref={ref}
        queueStatus={null}
        wideMode={false}
        onToggleWideMode={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    await act(async () => {
      ref.current?.openRandomImage('/api/nova/random-image/bing', 'Bing壁纸');
    });

    await waitFor(() => {
      expect(screen.getByAltText('Bing壁纸')).toHaveAttribute('src', 'blob:visible-image');
    });
    fireEvent.click(screen.getByTitle('添加到素材库'));
    fireEvent.click(screen.getByTitle('作为图生图参考'));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(runImageActionMock).toHaveBeenNthCalledWith(
      1,
      'add-to-assets',
      expect.objectContaining({
        blob: expect.any(Blob),
        sourceRef: '/api/nova/random-image/bing',
      }),
    );
    expect(runImageActionMock).toHaveBeenNthCalledWith(
      2,
      'use-as-reference',
      expect.objectContaining({
        blob: expect.any(Blob),
        sourceRef: '/api/nova/random-image/bing',
      }),
    );
    const displayedBlob = vi.mocked(URL.createObjectURL).mock.calls[0][0];
    expect(runImageActionMock.mock.calls[0][1].blob).toBe(displayedBlob);
    expect(runImageActionMock.mock.calls[1][1].blob).toBe(displayedBlob);
    unmount();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareGptImageMarkup } from '@/lib/gpt-image-markup';

let dimensions: Array<[number, number]>;
let transparent: boolean;

beforeEach(() => {
  dimensions = [[64, 32], [64, 32]];
  transparent = true;
  vi.stubGlobal('Image', class {
    naturalWidth: number;
    naturalHeight: number;
    onload?: () => void;
    constructor() { [this.naturalWidth, this.naturalHeight] = dimensions.shift()!; }
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray([255, 0, 0, transparent ? 0 : 255]) }),
  } as unknown as CanvasRenderingContext2D);
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('GPT Image markup preparation', () => {
  it('retains a matching transparent PNG as a separate upload', async () => {
    const file = new Blob(['overlay'], { type: 'image/png' });
    await expect(prepareGptImageMarkup(file, 'data:image/png;base64,reference')).resolves.toEqual({
      data: btoa('overlay'), mimeType: 'image/png',
    });
  });

  it('rejects a non-PNG upload before reading images', async () => {
    await expect(prepareGptImageMarkup(new Blob(['jpg'], { type: 'image/jpeg' }), 'ref')).rejects.toThrow('透明 PNG');
    expect(dimensions).toHaveLength(2);
  });

  it('rejects mismatching dimensions', async () => {
    dimensions = [[64, 32], [32, 64]];
    await expect(prepareGptImageMarkup(new Blob(['png'], { type: 'image/png' }), 'ref')).rejects.toThrow('尺寸必须');
  });

  it('rejects a flattened image even when PNG has an alpha channel', async () => {
    transparent = false;
    await expect(prepareGptImageMarkup(new Blob(['png'], { type: 'image/png' }), 'ref')).rejects.toThrow('必须包含透明区域');
  });

  it('rejects oversized pixel dimensions before allocating a canvas', async () => {
    dimensions = [[8192, 8192], [8192, 8192]];
    await expect(prepareGptImageMarkup(new Blob(['png'], { type: 'image/png' }), 'ref')).rejects.toThrow('16,777,216');
    expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();
  });
});

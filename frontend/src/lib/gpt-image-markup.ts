import { blobToDataUrl } from '@/lib/desktop-binary';
import type { GptImageMarkup } from '@/lib/model-capabilities';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('标注图或参考图读取失败'));
    image.src = src;
  });
}

export async function prepareGptImageMarkup(file: Blob, referenceSrc: string): Promise<GptImageMarkup> {
  if (file.type !== 'image/png') throw new Error('标注层必须是透明 PNG');
  if (file.size > 50 * 1024 * 1024) throw new Error('标注层不能超过 50MB');
  const dataUrl = await blobToDataUrl(file);
  const [markup, reference] = await Promise.all([loadImage(dataUrl), loadImage(referenceSrc)]);
  const width = markup.naturalWidth;
  const height = markup.naturalHeight;
  if (!width || !height || width * height > 16_777_216) throw new Error('标注层最多支持 16,777,216 像素');
  if (width !== reference.naturalWidth || height !== reference.naturalHeight) {
    throw new Error('标注层尺寸必须与首张参考图一致');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器不支持标注层检查');
  context.drawImage(markup, 0, 0);
  let hasTransparency = false;
  for (let y = 0; y < height && !hasTransparency; y += 64) {
    const pixels = context.getImageData(0, y, width, Math.min(64, height - y)).data;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] < 255) { hasTransparency = true; break; }
    }
  }
  if (!hasTransparency) throw new Error('标注层必须包含透明区域，请勿将标注与原图合并');
  return { data: dataUrl.split(',')[1], mimeType: 'image/png' };
}

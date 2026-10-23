// Only coarse RGB samples leave this function. No full-size bitmap, thumbnail,
// image metadata or reversible CSS blur is put in the preview envelope.
export function sampleImagePreview(bitmap) {
  const scale = 8 / Math.max(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw Error('浏览器无法生成图片预览。');
    ctx.fillStyle = '#e6ebe7'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const pixels = new Uint8Array(canvas.width * canvas.height * 3);
    for (let i = 0; i < pixels.length / 3; i++) for (let c = 0; c < 3; c++) pixels[i * 3 + c] = data[i * 4 + c];
    data.fill(0);
    return { width: canvas.width, height: canvas.height, pixels };
  } finally { canvas.width = canvas.height = 0; }
}
export function paintImagePreview(preview) {
  const canvas = document.createElement('canvas'); canvas.className = 'flash-preview';
  canvas.width = preview.width; canvas.height = preview.height;
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw Error('浏览器无法显示图片预览。');
  const data = ctx.createImageData(preview.width, preview.height);
  for (let i = 0; i < preview.width * preview.height; i++) {
    for (let c = 0; c < 3; c++) data.data[i * 4 + c] = preview.pixels[i * 3 + c];
    data.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(data, 0, 0); data.data.fill(0);
  return canvas;
}

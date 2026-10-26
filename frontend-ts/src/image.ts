/** Largest size a photo is sent at. Phone photos are 3-10 MB; this keeps them near 300-600 KB, which matters on a free database. */
export const MAX_SIDE = 1600;
const SKIP_BELOW = 1.2 * 1024 * 1024; // a small photo that already fits is sent untouched

/** The size an image of w x h pixels is scaled to so that neither side is longer than `max` (never scales up). */
export function fitWithin(w: number, h: number, max = MAX_SIDE): { w: number; h: number } {
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** Shrinks a big photo in the browser before upload. Falls back to the original file if anything about it fails. */
export async function shrinkImage(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); // keeps phone photos the right way up
    const { w, h } = fitWithin(bitmap.width, bitmap.height);
    if (file.size <= SKIP_BELOW && w === bitmap.width && h === bitmap.height) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.fillStyle = '#fff'; // a PNG's transparent areas would otherwise turn black in a JPEG
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob || blob.size >= file.size) return file; // never make it bigger
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

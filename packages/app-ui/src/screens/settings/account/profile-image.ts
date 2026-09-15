/** Resize uploads before persisting the small avatar in the profile. */
export async function prepareProfileImage(file: File): Promise<string> {
  if (
    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
    file.size > 10 * 1024 * 1024
  )
    throw new Error('INVALID_IMAGE');
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('INVALID_IMAGE');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const result = canvas.toDataURL('image/webp', 0.85);
    if (result.length > 175_000) throw new Error('INVALID_IMAGE');
    return result;
  } finally {
    bitmap.close();
  }
}

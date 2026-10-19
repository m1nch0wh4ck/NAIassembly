/** 목록용 썸네일(원본과 별도 파일). 원본은 절대 다시 인코딩하지 않습니다. */
export async function makeThumbnail(file: Blob, maxSide = 384): Promise<{ blob: Blob; width: number; height: number } | null> {
  try {
    const bmp = await createImageBitmap(file)
    const width = bmp.width
    const height = bmp.height
    const scale = Math.min(1, maxSide / Math.max(width, height))
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, 0, 0, w, h)
    bmp.close()
    let blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', 0.82))
    if (!blob || blob.type !== 'image/webp') blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.85))
    if (!blob) return null
    return { blob, width, height }
  } catch {
    return null
  }
}

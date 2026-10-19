// 파일 앞부분 바이트로 실제 이미지 형식을 판별합니다(확장자·브라우저가 알려준 MIME은 믿지 않음).

export interface ImageFormat {
  ext: string
  mime: string
}

export function sniffImage(b: Uint8Array): ImageFormat | null {
  const at = (i: number, ...v: number[]) => v.every((x, j) => b[i + j] === x)
  const ascii = (i: number, s: string) => [...s].every((c, j) => b[i + j] === c.charCodeAt(0))
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { ext: 'png', mime: 'image/png' }
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return { ext: 'jpg', mime: 'image/jpeg' }
  if (b.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { ext: 'webp', mime: 'image/webp' }
  if (b.length >= 6 && (ascii(0, 'GIF87a') || ascii(0, 'GIF89a'))) return { ext: 'gif', mime: 'image/gif' }
  if (b.length >= 12 && ascii(4, 'ftyp') && (ascii(8, 'avif') || ascii(8, 'avis'))) return { ext: 'avif', mime: 'image/avif' }
  return null
}

export async function sniffFile(file: Blob): Promise<ImageFormat | null> {
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer())
  return sniffImage(head)
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

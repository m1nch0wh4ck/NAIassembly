import { deflateSync } from 'node:zlib'

function crc32(buf: Uint8Array) {
  let c: number, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** NovelAI처럼 tEXt 메타데이터(Comment 등)가 들어 있는 작은 PNG */
export function pngWithMetadata(w = 4, h = 3, meta: Record<string, string> = { Comment: '{"prompt":"1girl, smile","seed":123}', Software: 'NovelAI' }) {
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w)
  dv.setUint32(4, h)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const raw = new Uint8Array((w * 3 + 1) * h)
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 37) & 0xff
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...Object.entries(meta).map(([k, v]) => chunk('tEXt', new TextEncoder().encode(`${k}\0${v}`))),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array()),
  ]
  const total = parts.reduce((a, p) => a + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

export function readPngText(b: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {}
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let o = 8
  while (o < b.length) {
    const len = dv.getUint32(o)
    const type = new TextDecoder().decode(b.subarray(o + 4, o + 8))
    if (type === 'tEXt') {
      const d = b.subarray(o + 8, o + 8 + len)
      const z = d.indexOf(0)
      out[new TextDecoder().decode(d.subarray(0, z))] = new TextDecoder().decode(d.subarray(z + 1))
    }
    o += 12 + len
  }
  return out
}

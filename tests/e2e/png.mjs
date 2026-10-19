import { deflateSync } from 'node:zlib'
function crc32(buf) {
  let crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
/** NovelAI처럼 tEXt 메타데이터가 들어 있는 PNG (w×h, 색 패턴은 seed로 구분) */
export function pngWithMetadata(w = 64, h = 48, seed = 1, meta = { Comment: '{"prompt":"1girl, smile","seed":123}', Software: 'NovelAI' }) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 3 + 1) + 1 + x * 3
    raw[o] = (x * 4 * seed) & 0xff
    raw[o + 1] = (y * 5 + seed * 40) & 0xff
    raw[o + 2] = (seed * 70) & 0xff
  }
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...Object.entries(meta).map(([k, v]) => chunk('tEXt', Buffer.from(`${k}\0${v}`, 'latin1'))),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]))
}
export function readPngText(b) {
  const buf = Buffer.from(b)
  const out = {}
  let o = 8
  while (o < buf.length) {
    const len = buf.readUInt32BE(o)
    const type = buf.toString('latin1', o + 4, o + 8)
    if (type === 'tEXt') {
      const d = buf.subarray(o + 8, o + 8 + len)
      const z = d.indexOf(0)
      out[d.toString('latin1', 0, z)] = d.toString('latin1', z + 1)
    }
    o += 12 + len
  }
  return out
}

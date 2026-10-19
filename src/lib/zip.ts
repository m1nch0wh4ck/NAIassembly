import { Zip, ZipPassThrough, ZipDeflate, strToU8 } from 'fflate'

/** 이미지는 압축하지 않고(바이트 그대로) 담는 ZIP 작성기. 한국어 파일명은 UTF-8 플래그와 함께 저장됩니다. */
export class ZipBuilder {
  private chunks: Uint8Array[] = []
  private zip: Zip
  private done: Promise<void>
  private names = new Set<string>()

  constructor() {
    let resolve!: () => void
    let reject!: (e: unknown) => void
    this.done = new Promise((res, rej) => ((resolve = res), (reject = rej)))
    this.zip = new Zip((err, chunk, final) => {
      if (err) return reject(err)
      this.chunks.push(chunk)
      if (final) resolve()
    })
  }

  private claim(name: string) {
    if (name.includes('..') || name.startsWith('/') || name.includes('\\')) throw new Error(`잘못된 ZIP 경로: ${name}`)
    const k = name.toLowerCase()
    if (this.names.has(k)) throw new Error(`ZIP 안에서 이름이 겹칩니다: ${name}`)
    this.names.add(k)
  }

  /** 원본 바이트 그대로 저장(무압축) */
  addStored(name: string, data: Uint8Array, mtime?: Date) {
    this.claim(name)
    const f = new ZipPassThrough(name)
    if (mtime) f.mtime = mtime
    this.zip.add(f)
    f.push(data, true)
  }

  addText(name: string, text: string) {
    this.claim(name)
    const f = new ZipDeflate(name, { level: 6 })
    this.zip.add(f)
    f.push(strToU8(text), true)
  }

  async finish(): Promise<Blob> {
    this.zip.end()
    await this.done
    return new Blob(this.chunks as BlobPart[], { type: 'application/zip' })
  }
}

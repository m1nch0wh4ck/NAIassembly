import { describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import { planExportNames, sanitizeBaseName, duplicateValues } from '../src/lib/filename'
import { sniffImage } from '../src/lib/format'
import { composeTags, appendMissing, decideTagSync, tagsNeedReview } from '../src/lib/tags'
import { threeWayMerge } from '../src/lib/merge'
import { ZipBuilder } from '../src/lib/zip'
import { buildManifest, parseBackup, BACKUP_FORMAT } from '../src/lib/backup'
import { sha256Hex } from '../src/lib/hash'
import { pngWithMetadata, readPngText } from './fixtures'
import type { Candidate, Project, Reaction, VisualItem } from '../src/types'

const vi = (tag: string, label = ''): VisualItem => ({ key: crypto.randomUUID(), category: 'mouth', label, tag, option_id: null })

describe('파일명', () => {
  it('금지 문자·경로 문자를 바꾸고 한국어는 유지', () => {
    const r = sanitizeBaseName('../당황/웃음:*?"<>|', 'png', 'x')
    expect(r.name).toBe('_당황_웃음_______')
    expect(r.name).not.toMatch(/[\\/:*?"<>|]/)
  })
  it('앞뒤 점·공백, 예약어, 빈 이름 처리', () => {
    expect(sanitizeBaseName('  ..숨김.  ', 'png', 'x').name).toBe('숨김')
    expect(sanitizeBaseName('CON', 'png', 'x').name).toBe('CON_')
    expect(sanitizeBaseName('   ', 'png', 'r-03').name).toBe('r-03')
    expect(sanitizeBaseName('///', 'png', 'r-04').name).toBe('___')
  })
  it('입력한 확장자는 실제 형식으로 대체', () => {
    expect(sanitizeBaseName('smile.png', 'webp', 'x').name).toBe('smile')
  })
  it('NFD 한글을 NFC로 정규화', () => {
    expect(sanitizeBaseName('당황'.normalize('NFD'), 'png', 'x').name).toBe('당황')
  })
  it('긴 이름은 UTF-8 기준으로 자름', () => {
    const r = sanitizeBaseName('가'.repeat(300), 'png', 'x')
    expect(new TextEncoder().encode(r.name).length).toBeLessThanOrEqual(180)
  })
  it('중복 파일명은 덮어쓰지 않고 번호를 붙임(대소문자 무시)', () => {
    const out = planExportNames([
      { item: 1, desired: '당황', ext: 'png', fallback: 'a' },
      { item: 2, desired: '당황', ext: 'png', fallback: 'b' },
      { item: 3, desired: 'Smile', ext: 'png', fallback: 'c' },
      { item: 4, desired: 'smile', ext: 'png', fallback: 'd' },
      { item: 5, desired: '당황_2', ext: 'png', fallback: 'e' },
      { item: 6, desired: '당황', ext: 'webp', fallback: 'f' },
    ])
    expect(out.map((o) => o.fileName)).toEqual(['당황.png', '당황_2.png', 'Smile.png', 'smile_2.png', '당황_2_2.png', '당황.webp'])
    expect(out[1].duplicateOf).toBe('당황.png')
    expect(new Set(out.map((o) => o.fileName.toLowerCase())).size).toBe(out.length)
  })
  it('중복 값 검사', () => {
    expect([...duplicateValues(['a', ' A', 'b', ''])]).toEqual(['a'])
  })
})

describe('형식 판별', () => {
  it('PNG/JPEG/WEBP/GIF', () => {
    expect(sniffImage(pngWithMetadata())?.ext).toBe('png')
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe('jpg')
    expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))?.ext).toBe('webp')
    expect(sniffImage(new TextEncoder().encode('GIF89a'))?.ext).toBe('gif')
    expect(sniffImage(new TextEncoder().encode('hello world!'))).toBeNull()
  })
})

describe('태그 조립', () => {
  it('저장된 태그를 순서대로 중복 없이 합침', () => {
    expect(composeTags([vi('blush, smile'), vi('Smile'), vi(''), vi('looking away')])).toBe('blush, smile, looking away')
  })
  it('직접 수정하지 않았으면 자동 반영, 수정했으면 보존', () => {
    const v = [vi('blush')]
    expect(decideTagSync('smile', 'smile', v).autoApply).toBe(true)
    expect(decideTagSync('smile, 내가 쓴 태그', 'smile', v).autoApply).toBe(false)
    expect(tagsNeedReview('smile, 내가 쓴 태그', 'smile', v)).toBe(true)
    expect(appendMissing('smile, 내가 쓴 태그', 'smile, blush')).toBe('smile, 내가 쓴 태그, blush')
  })
})

describe('3방향 병합', () => {
  it('서로 다른 필드는 자동 병합', () => {
    const r = threeWayMerge({ emotion: 'a', memo: 'm' }, { emotion: 'a', memo: 'm2' }, { emotion: 'b' })
    expect(r).toEqual({ rebased: { emotion: 'b' }, conflicts: [] })
  })
  it('같은 필드를 다르게 바꾸면 충돌, 연결 필드도 함께', () => {
    const r = threeWayMerge(
      { status: 'todo', adopted_candidate_id: null },
      { status: 'generated', adopted_candidate_id: null },
      { status: 'rework', adopted_candidate_id: null },
    )
    expect(r.conflicts.sort()).toEqual(['adopted_candidate_id', 'status'])
  })
  it('같은 값으로 바꿨으면 충돌 아님', () => {
    expect(threeWayMerge({ memo: 'a' }, { memo: 'b' }, { memo: 'b' })).toEqual({ rebased: {}, conflicts: [] })
  })
})

describe('ZIP 내보내기', () => {
  it('원본 바이트와 PNG 메타데이터, 한국어 파일명이 그대로 유지됨', async () => {
    const png = pngWithMetadata()
    const z = new ZipBuilder()
    z.addStored('당황.png', png)
    z.addStored('수줍음_2.png', png)
    const blob = await z.finish()
    const buf = new Uint8Array(await blob.arrayBuffer())
    // 로컬 헤더의 UTF-8 플래그(bit 11)
    expect((buf[6] | (buf[7] << 8)) & 0x800).toBe(0x800)
    const out = unzipSync(buf)
    expect(Object.keys(out)).toEqual(['당황.png', '수줍음_2.png'])
    expect(await sha256Hex(out['당황.png'])).toBe(await sha256Hex(png))
    expect(readPngText(out['당황.png']).Comment).toContain('1girl')
  })
  it('같은 이름을 두 번 넣으면 거부', () => {
    const z = new ZipBuilder()
    z.addStored('a.png', new Uint8Array([1]))
    expect(() => z.addStored('A.png', new Uint8Array([1]))).toThrow()
    expect(() => z.addStored('../evil.png', new Uint8Array([1]))).toThrow()
  })
})

async function makeBackup(mutate?: (m: any, files: Record<string, Uint8Array>) => void) {
  const png = pngWithMetadata()
  const sha = await sha256Hex(png)
  const project = { id: 'p', name: '하루', character_name: '하루', memo: '메모', created_at: 't', updated_at: 't' } as Project
  const r: Reaction = {
    id: 'r1', owner_id: 'u', project_id: 'p', sort_order: 1, emotion: '당황', expression: '시선을 피함',
    visual: [vi('looking away', '시선 회피')], tags: 'looking away', tags_auto: 'looking away', keyword: '당황', filename: '당황',
    memo: '', status: 'adopted', adopted_candidate_id: 'c1', version: 3, created_at: 't', updated_at: 't',
  }
  const c: Candidate = {
    id: 'c1', owner_id: 'u', project_id: 'p', reaction_id: 'r1', storage_path: 'u/p/r1/c1.png', thumb_path: null, original_name: 'nai-123.png',
    mime_type: 'image/png', ext: 'png', byte_size: png.length, sha256: sha, width: 4, height: 3, memo: '좋음', created_at: 't',
  }
  const m = buildManifest(project, [r], new Map([['r1', [c]]]))
  const files: Record<string, Uint8Array> = { 'images/c1.png': png }
  mutate?.(m, files)
  const z = new ZipBuilder()
  z.addText('backup.json', JSON.stringify(m))
  for (const [k, v] of Object.entries(files)) z.addStored(k, v)
  return { bytes: new Uint8Array(await (await z.finish()).arrayBuffer()), png }
}

describe('백업', () => {
  it('설계·후보·채택이 왕복 유지', async () => {
    const { bytes, png } = await makeBackup()
    const p = await parseBackup(bytes)
    expect(p.manifest.format).toBe(BACKUP_FORMAT)
    const r = p.manifest.reactions[0]
    expect(r.emotion).toBe('당황')
    expect(r.expression).toBe('시선을 피함')
    expect(r.status).toBe('adopted')
    expect(r.adopted_candidate_id).toBe('c1')
    expect(r.candidates[0].original_name).toBe('nai-123.png')
    expect(await sha256Hex(p.files.get('c1')!)).toBe(await sha256Hex(png))
  })
  it('손상된 이미지는 거부', async () => {
    const { bytes } = await makeBackup((_m, f) => { f['images/c1.png'] = f['images/c1.png'].slice(0, -3) })
    await expect(parseBackup(bytes)).rejects.toThrow(/손상/)
  })
  it('빠진 이미지, 미래 버전, 다른 파일은 거부', async () => {
    await expect(parseBackup((await makeBackup((_m, f) => { delete f['images/c1.png'] })).bytes)).rejects.toThrow(/없습니다/)
    await expect(parseBackup((await makeBackup((m) => { m.formatVersion = 99 })).bytes)).rejects.toThrow(/새로운/)
    await expect(parseBackup(new Uint8Array([1, 2, 3]))).rejects.toThrow(/ZIP/)
    await expect(parseBackup((await makeBackup((m) => { m.format = 'x' })).bytes)).rejects.toThrow(/형식/)
  })
  it('채택 정보가 어긋나면 고쳐서 경고', async () => {
    const { bytes } = await makeBackup((m) => { m.reactions[0].adopted_candidate_id = 'zzz' })
    const p = await parseBackup(bytes)
    expect(p.manifest.reactions[0].status).toBe('generated')
    expect(p.manifest.reactions[0].adopted_candidate_id).toBeNull()
    expect(p.warnings.join()).toContain("채택")
  })
})

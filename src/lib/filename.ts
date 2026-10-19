// 내보내기 파일명 정리. 원본 파일명은 따로 보관하고, 여기서는 ZIP 안의 이름만 만듭니다.

const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f]/g
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i
/** ZIP·대부분 파일시스템에서 안전한 이름 길이(UTF-8 바이트, 확장자 제외) */
const MAX_BYTES = 180

function utf8Len(s: string) {
  return new TextEncoder().encode(s).length
}

function truncateBytes(s: string, max: number) {
  if (utf8Len(s) <= max) return s
  let out = ''
  for (const ch of s) {
    if (utf8Len(out + ch) > max) break
    out += ch
  }
  return out
}

export interface SanitizeResult {
  name: string
  changed: boolean
  notes: string[]
}

/** 확장자 없는 기본 이름을 안전하게 바꿉니다. 사용자가 확장자를 붙였다면 실제 형식 확장자와 겹치지 않게 제거합니다. */
export function sanitizeBaseName(input: string, ext: string, fallback: string): SanitizeResult {
  const notes: string[] = []
  let s = (input ?? '').normalize('NFC')
  const extRe = new RegExp(`\\.(${['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', ext].join('|')})$`, 'i')
  if (extRe.test(s.trim())) {
    s = s.trim().replace(extRe, '')
    notes.push('입력한 확장자는 실제 이미지 형식 확장자로 바뀝니다')
  }
  const replaced = s.replace(FORBIDDEN, '_')
  if (replaced !== s) notes.push('금지 문자(\\ / : * ? " < > | 제어문자)를 _로 바꿈')
  s = replaced.replace(/\s+/g, ' ').trim()
  const stripped = s.replace(/^[.\s]+|[.\s]+$/g, '')
  if (stripped !== s) notes.push('앞뒤 점·공백 제거')
  s = stripped
  if (RESERVED.test(s)) {
    s = `${s}_`
    notes.push('Windows 예약 이름이라 _를 붙임')
  }
  const cut = truncateBytes(s, MAX_BYTES)
  if (cut !== s) notes.push('너무 길어 잘라냄')
  s = cut.trim()
  if (!s) {
    s = fallback
    if ((input ?? '').trim()) notes.push('사용할 수 있는 문자가 없어 기본 이름 사용')
    else notes.push('파일명이 비어 있어 기본 이름 사용')
  }
  return { name: s, changed: s !== (input ?? '').trim(), notes }
}

export interface ExportEntry<T = unknown> {
  item: T
  desired: string
  ext: string
  fallback: string
}

export interface PlannedName<T = unknown> {
  item: T
  base: string
  fileName: string
  notes: string[]
  duplicateOf: string | null
}

/** 같은 이름(대소문자 무시)이 겹치면 _2, _3… 을 붙여 덮어쓰기를 막습니다. */
export function planExportNames<T>(entries: ExportEntry<T>[]): PlannedName<T>[] {
  const used = new Set<string>()
  const firstOwner = new Map<string, string>()
  return entries.map((e) => {
    const r = sanitizeBaseName(e.desired, e.ext, e.fallback)
    const ext = e.ext.toLowerCase()
    let base = r.name
    let fileName = `${base}.${ext}`
    let key = fileName.toLowerCase()
    let duplicateOf: string | null = null
    if (used.has(key)) {
      duplicateOf = firstOwner.get(key) ?? fileName
      let n = 2
      while (used.has(`${r.name}_${n}.${ext}`.toLowerCase())) n++
      base = `${r.name}_${n}`
      fileName = `${base}.${ext}`
      key = fileName.toLowerCase()
      r.notes.push(`"${duplicateOf}"와 이름이 겹쳐 _${n}을 붙임`)
    }
    used.add(key)
    firstOwner.set(key, fileName)
    return { item: e.item, base, fileName, notes: r.notes, duplicateOf }
  })
}

/** 목록 표시용: 같은 값(공백 정리, 대소문자 무시)이 2개 이상인 값의 집합 */
export function duplicateValues(values: string[], caseInsensitive = true): Set<string> {
  const count = new Map<string, number>()
  for (const v of values) {
    const k = normKey(v, caseInsensitive)
    if (!k) continue
    count.set(k, (count.get(k) ?? 0) + 1)
  }
  return new Set([...count].filter(([, n]) => n > 1).map(([k]) => k))
}

export function normKey(v: string, caseInsensitive = true) {
  const t = (v ?? '').normalize('NFC').trim()
  return caseInsensitive ? t.toLowerCase() : t
}

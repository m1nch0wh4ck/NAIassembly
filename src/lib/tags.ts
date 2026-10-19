import type { VisualItem } from '../types'

/** 쉼표로 구분된 태그 문자열을 항목 배열로 */
export function splitTags(s: string): string[] {
  return (s ?? '')
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean)
}

const key = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ')

/** 시각 요소들의 태그를 순서대로 모아 중복 없이 이어 붙입니다. 태그 내용은 사용자가 저장한 그대로 씁니다. */
export function composeTags(items: VisualItem[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const it of items) {
    for (const t of splitTags(it.tag)) {
      if (seen.has(key(t))) continue
      seen.add(key(t))
      out.push(t)
    }
  }
  return out.join(', ')
}

/** current에 없는 태그만 뒤에 덧붙입니다(사용자 수정 내용 보존). */
export function appendMissing(current: string, add: string): string {
  const have = new Set(splitTags(current).map(key))
  const extra = splitTags(add).filter((t) => !have.has(key(t)))
  if (!extra.length) return current
  const base = current.trim().replace(/,\s*$/, '')
  return base ? `${base}, ${extra.join(', ')}` : extra.join(', ')
}

export interface TagSyncDecision {
  /** 사용자가 태그를 직접 고친 적 없음 → 자동 반영해도 안전 */
  autoApply: boolean
  composed: string
}

/**
 * 시각 요소가 바뀐 뒤 태그를 어떻게 다룰지 정합니다.
 * tags가 마지막 자동 조립 결과(tags_auto)와 같을 때만 자동으로 바꿉니다.
 */
export function decideTagSync(tags: string, tagsAuto: string, visual: VisualItem[]): TagSyncDecision {
  const composed = composeTags(visual)
  const untouched = tags.trim() === tagsAuto.trim()
  return { autoApply: untouched, composed }
}

/** 시각 요소 기준 태그가 현재 태그와 어긋나 사용자 확인이 필요한지 */
export function tagsNeedReview(tags: string, tagsAuto: string, visual: VisualItem[]): boolean {
  const composed = composeTags(visual)
  return composed.trim() !== tagsAuto.trim() && tags.trim() !== tagsAuto.trim()
}

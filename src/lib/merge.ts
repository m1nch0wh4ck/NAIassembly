// 간단한 3방향 병합: 내가 바꾼 필드를 서버가 따로 바꾸지 않았으면 자동 병합, 둘 다 바꿨으면 충돌.

export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 함께 움직여야 하는 필드 묶음(하나가 충돌하면 묶음 전체를 충돌로 봄) */
const LINKED: string[][] = [
  ['status', 'adopted_candidate_id'],
  ['tags', 'tags_auto', 'visual'],
]

export interface MergeResult {
  /** 서버 최신값 위에 다시 보낼 내 변경 */
  rebased: Record<string, unknown>
  conflicts: string[]
}

export function threeWayMerge(
  base: Record<string, unknown>,
  server: Record<string, unknown>,
  mine: Record<string, unknown>,
): MergeResult {
  const conflicts = new Set<string>()
  for (const f of Object.keys(mine)) {
    const serverChanged = !same(server[f], base[f])
    if (serverChanged && !same(server[f], mine[f])) conflicts.add(f)
  }
  for (const group of LINKED) {
    if (group.some((f) => conflicts.has(f))) for (const f of group) if (f in mine) conflicts.add(f)
  }
  const rebased: Record<string, unknown> = {}
  for (const [f, v] of Object.entries(mine)) {
    if (conflicts.has(f)) continue
    if (!same(server[f], v)) rebased[f] = v
  }
  return { rebased, conflicts: [...conflicts] }
}

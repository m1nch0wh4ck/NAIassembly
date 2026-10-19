/** 정렬값: 목록 중간에 끼워 넣을 때 앞뒤 값의 중간을 씁니다. */
export function orderBetween(prev: number | undefined, next: number | undefined): number {
  if (prev === undefined && next === undefined) return 1024
  if (prev === undefined) return (next as number) - 1024
  if (next === undefined) return prev + 1024
  return (prev + next) / 2
}

/** 간격이 너무 좁아지면 전체를 다시 매깁니다. */
export function needsRenumber(values: number[]): boolean {
  for (let i = 1; i < values.length; i++) if (Math.abs(values[i] - values[i - 1]) < 1e-6) return true
  return false
}

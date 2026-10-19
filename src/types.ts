export type Status = 'todo' | 'generated' | 'rework' | 'adopted'

export const STATUS_LABEL: Record<Status, string> = {
  todo: '미작업',
  generated: '생성됨',
  rework: '재작업',
  adopted: '채택',
}
export const STATUSES: Status[] = ['todo', 'generated', 'rework', 'adopted']

export interface Project {
  id: string
  owner_id: string
  name: string
  character_name: string
  memo: string
  version: number
  created_at: string
  updated_at: string
}

/** 리액션에 붙은 시각 요소 한 줄. 선택 항목에서 가져와도 값은 복사본이므로 자유롭게 고칠 수 있습니다. */
export interface VisualItem {
  key: string
  category: string
  label: string
  tag: string
  option_id: string | null
}

export interface Reaction {
  id: string
  owner_id: string
  project_id: string
  sort_order: number
  emotion: string
  expression: string
  visual: VisualItem[]
  tags: string
  /** 시각 요소로 마지막에 자동 조립한 태그. tags와 같으면 사용자가 직접 고치지 않은 상태입니다. */
  tags_auto: string
  keyword: string
  filename: string
  memo: string
  status: Status
  adopted_candidate_id: string | null
  version: number
  created_at: string
  updated_at: string
}

export interface Candidate {
  id: string
  owner_id: string
  project_id: string
  reaction_id: string
  storage_path: string
  thumb_path: string | null
  original_name: string
  mime_type: string
  ext: string
  byte_size: number
  sha256: string
  width: number | null
  height: number | null
  memo: string
  created_at: string
}

export interface VisualOption {
  id: string
  owner_id: string
  category: string
  label: string
  tag: string
  sort_order: number
  created_at: string
  updated_at: string
}

/** 사용자가 편집하는 리액션 필드 */
export const REACTION_EDITABLE = [
  'sort_order', 'emotion', 'expression', 'visual', 'tags', 'tags_auto', 'keyword', 'filename', 'memo', 'status', 'adopted_candidate_id',
] as const
export type ReactionField = (typeof REACTION_EDITABLE)[number]

export const PROJECT_EDITABLE = ['name', 'character_name', 'memo'] as const
export type ProjectField = (typeof PROJECT_EDITABLE)[number]

export const FIELD_LABEL: Record<string, string> = {
  sort_order: '순서',
  emotion: '감정·상태명',
  expression: '캐릭터별 표현 설명',
  visual: '시각 요소',
  tags: 'NAI 표현 태그',
  tags_auto: '자동 조립 태그',
  keyword: '호출 키워드',
  filename: '내보내기 파일명',
  memo: '메모',
  status: '진행 상태',
  adopted_candidate_id: '채택 이미지',
  name: '프로젝트명',
  character_name: '캐릭터명',
}

export const CATEGORIES: { key: string; label: string }[] = [
  { key: 'eyes', label: '눈·눈썹' },
  { key: 'mouth', label: '입' },
  { key: 'gaze', label: '시선' },
  { key: 'pose', label: '고개·자세' },
  { key: 'hands', label: '손동작' },
  { key: 'extra', label: '홍조·땀 등 부가 표현' },
  { key: 'etc', label: '기타' },
]
export const categoryLabel = (k: string) => CATEGORIES.find((c) => c.key === k)?.label ?? k

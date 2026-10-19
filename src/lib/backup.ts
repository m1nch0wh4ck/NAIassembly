import { unzipSync, strFromU8 } from 'fflate'
import type { Candidate, Project, Reaction, Status, VisualItem } from '../types'
import { STATUSES } from '../types'
import { sniffImage } from './format'
import { sha256Hex } from './hash'

export const BACKUP_FORMAT = 'nai-reaction-studio-backup'
export const BACKUP_VERSION = 1

export interface BackupCandidate {
  id: string
  file: string
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

export interface BackupReaction {
  id: string
  sort_order: number
  emotion: string
  expression: string
  visual: VisualItem[]
  tags: string
  tags_auto: string
  keyword: string
  filename: string
  memo: string
  status: Status
  adopted_candidate_id: string | null
  created_at: string
  updated_at: string
  candidates: BackupCandidate[]
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT
  formatVersion: number
  exportedAt: string
  project: { name: string; character_name: string; memo: string; created_at: string; updated_at: string }
  reactions: BackupReaction[]
}

export function buildManifest(
  project: Project,
  reactions: Reaction[],
  candidatesByReaction: Map<string, Candidate[]>,
): BackupManifest {
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    project: {
      name: project.name,
      character_name: project.character_name,
      memo: project.memo,
      created_at: project.created_at,
      updated_at: project.updated_at,
    },
    reactions: reactions.map((r) => ({
      id: r.id,
      sort_order: r.sort_order,
      emotion: r.emotion,
      expression: r.expression,
      visual: r.visual,
      tags: r.tags,
      tags_auto: r.tags_auto,
      keyword: r.keyword,
      filename: r.filename,
      memo: r.memo,
      status: r.status,
      adopted_candidate_id: r.adopted_candidate_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
      candidates: (candidatesByReaction.get(r.id) ?? []).map((c) => ({
        id: c.id,
        file: `images/${c.id}.${c.ext}`,
        original_name: c.original_name,
        mime_type: c.mime_type,
        ext: c.ext,
        byte_size: c.byte_size,
        sha256: c.sha256,
        width: c.width,
        height: c.height,
        memo: c.memo,
        created_at: c.created_at,
      })),
    })),
  }
}

// ───────────── 불러오기 검증 ─────────────

export interface ParsedBackup {
  manifest: BackupManifest
  files: Map<string, Uint8Array>
  warnings: string[]
  imageCount: number
  totalBytes: number
}

class BackupError extends Error {}

const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function req(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new BackupError(msg)
}

function str(o: Record<string, unknown>, k: string, where: string, max = 20000): string {
  const v = o[k] ?? ''
  req(isStr(v), `${where}: ${k} 값이 문자열이 아닙니다`)
  req((v as string).length <= max, `${where}: ${k} 값이 너무 깁니다`)
  return v as string
}

function nullableInt(v: unknown): number | null {
  return isNum(v) ? Math.round(v) : null
}

/** 백업 ZIP 바이트를 검증합니다. 문제가 있으면 예외를 던지며, 아무것도 저장하지 않습니다. */
export async function parseBackup(zipBytes: Uint8Array): Promise<ParsedBackup> {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(zipBytes)
  } catch {
    throw new BackupError('ZIP 파일을 열 수 없습니다. 이 앱에서 만든 백업 파일인지 확인하세요.')
  }
  const raw = entries['backup.json']
  req(raw, 'backup.json이 없습니다. 이 앱의 프로젝트 백업 파일이 아닙니다.')
  let json: unknown
  try {
    json = JSON.parse(strFromU8(raw))
  } catch {
    throw new BackupError('backup.json을 해석할 수 없습니다(파일 손상).')
  }
  req(isObj(json), 'backup.json 형식이 올바르지 않습니다.')
  const m = json as Record<string, unknown>
  req(m.format === BACKUP_FORMAT, '이 앱의 백업 형식이 아닙니다.')
  req(isNum(m.formatVersion), '백업 형식 버전이 없습니다.')
  req(
    (m.formatVersion as number) <= BACKUP_VERSION,
    `이 백업은 더 새로운 앱(형식 v${m.formatVersion})에서 만들어졌습니다. 앱을 업데이트한 뒤 불러오세요.`,
  )
  req(isObj(m.project), '프로젝트 정보가 없습니다.')
  req(Array.isArray(m.reactions), '리액션 목록이 없습니다.')
  const warnings: string[] = []
  const p = m.project as Record<string, unknown>
  const project = {
    name: str(p, 'name', '프로젝트', 200),
    character_name: str(p, 'character_name', '프로젝트', 200),
    memo: str(p, 'memo', '프로젝트'),
    created_at: str(p, 'created_at', '프로젝트', 64),
    updated_at: str(p, 'updated_at', '프로젝트', 64),
  }

  const files = new Map<string, Uint8Array>()
  const seenReaction = new Set<string>()
  const seenCandidate = new Set<string>()
  let totalBytes = 0
  const reactions: BackupReaction[] = []
  for (const [i, rv] of (m.reactions as unknown[]).entries()) {
    const where = `리액션 ${i + 1}`
    req(isObj(rv), `${where}: 형식 오류`)
    const r = rv as Record<string, unknown>
    const id = str(r, 'id', where, 64)
    req(id && !seenReaction.has(id), `${where}: ID가 비었거나 중복됩니다`)
    seenReaction.add(id)
    const status = r.status as Status
    req(STATUSES.includes(status), `${where}: 알 수 없는 상태 "${String(r.status)}"`)
    req(Array.isArray(r.visual ?? []), `${where}: 시각 요소 형식 오류`)
    const visual: VisualItem[] = ((r.visual ?? []) as unknown[]).map((v, j) => {
      req(isObj(v), `${where} 시각 요소 ${j + 1}: 형식 오류`)
      const o = v as Record<string, unknown>
      return {
        key: str(o, 'key', where, 64) || crypto.randomUUID(),
        category: str(o, 'category', where, 50),
        label: str(o, 'label', where, 200),
        tag: str(o, 'tag', where, 1000),
        option_id: null,
      }
    })
    req(Array.isArray(r.candidates ?? []), `${where}: 후보 목록 형식 오류`)
    const candidates: BackupCandidate[] = []
    for (const [j, cv] of ((r.candidates ?? []) as unknown[]).entries()) {
      const cw = `${where} 후보 ${j + 1}`
      req(isObj(cv), `${cw}: 형식 오류`)
      const c = cv as Record<string, unknown>
      const cid = str(c, 'id', cw, 64)
      req(cid && !seenCandidate.has(cid), `${cw}: ID가 비었거나 중복됩니다`)
      seenCandidate.add(cid)
      const file = str(c, 'file', cw, 300)
      req(/^images\/[^/\\]+$/.test(file), `${cw}: 이미지 경로가 올바르지 않습니다`)
      const bytes = entries[file]
      req(bytes, `${cw}: 이미지 파일(${file})이 백업에 없습니다`)
      const sha = str(c, 'sha256', cw, 64)
      const actual = await sha256Hex(bytes)
      req(actual === sha, `${cw}: 이미지(${file})의 내용이 기록과 다릅니다(파일 손상)`)
      const fmt = sniffImage(bytes)
      req(fmt, `${cw}: 지원하지 않는 이미지 형식입니다`)
      files.set(cid, bytes)
      totalBytes += bytes.length
      candidates.push({
        id: cid,
        file,
        original_name: str(c, 'original_name', cw, 500),
        mime_type: fmt!.mime,
        ext: fmt!.ext,
        byte_size: bytes.length,
        sha256: sha,
        width: nullableInt(c.width),
        height: nullableInt(c.height),
        memo: str(c, 'memo', cw, 5000),
        created_at: str(c, 'created_at', cw, 64),
      })
    }
    let adopted = (r.adopted_candidate_id ?? null) as string | null
    let st: Status = status
    if (adopted !== null && !candidates.some((c) => c.id === adopted)) {
      warnings.push(`${where}: 채택 이미지가 후보에 없어 채택을 해제했습니다`)
      adopted = null
    }
    if (st === 'adopted' && !adopted) {
      st = candidates.length ? 'generated' : 'todo'
      warnings.push(`${where}: 채택 이미지가 없어 상태를 '${st === 'todo' ? '미작업' : '생성됨'}'으로 바꿨습니다`)
    }
    if (st !== 'adopted' && adopted) st = 'adopted'
    reactions.push({
      id,
      sort_order: isNum(r.sort_order) ? r.sort_order : (i + 1) * 1024,
      emotion: str(r, 'emotion', where, 200),
      expression: str(r, 'expression', where, 5000),
      visual,
      tags: str(r, 'tags', where),
      tags_auto: str(r, 'tags_auto', where),
      keyword: str(r, 'keyword', where, 500),
      filename: str(r, 'filename', where, 300),
      memo: str(r, 'memo', where),
      status: st,
      adopted_candidate_id: adopted,
      created_at: str(r, 'created_at', where, 64),
      updated_at: str(r, 'updated_at', where, 64),
      candidates,
    })
  }
  return {
    manifest: {
      format: BACKUP_FORMAT,
      formatVersion: m.formatVersion as number,
      exportedAt: isStr(m.exportedAt) ? m.exportedAt : '',
      project,
      reactions,
    },
    files,
    warnings,
    imageCount: files.size,
    totalBytes,
  }
}

export function isBackupError(e: unknown): e is Error {
  return e instanceof BackupError
}

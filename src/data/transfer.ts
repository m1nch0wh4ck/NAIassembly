// 내보내기·백업·복원·목록 복제·저장 공간 점검
import { sb } from '../supabase'
import { BUCKET } from '../config'
import type { Candidate, Project, Reaction } from '../types'
import { planExportNames, type PlannedName } from '../lib/filename'
import { sha256Hex } from '../lib/hash'
import { ZipBuilder } from '../lib/zip'
import { buildManifest, parseBackup, type ParsedBackup } from '../lib/backup'
import { makeThumbnail } from '../lib/thumb'
import { createReactions, getState, loadProjects, pathsOf, pickDesign, refreshProject, removeFiles, uid, view } from './store'

export type Progress = (done: number, total: number, label: string) => void

// ───────────── 이미지 주소(서명 URL) ─────────────

const urlCache = new Map<string, { url: string; exp: number }>()
const waiting = new Map<string, ((u: string | null) => void)[]>()
let batchTimer: ReturnType<typeof setTimeout> | null = null

/** 비공개 이미지의 임시 주소. 여러 요청을 모아 한 번에 받습니다. */
export function signedUrl(path: string): Promise<string | null> {
  const c = urlCache.get(path)
  if (c && c.exp > Date.now() + 60_000) return Promise.resolve(c.url)
  return new Promise((res) => {
    const arr = waiting.get(path) ?? []
    arr.push(res)
    waiting.set(path, arr)
    if (!batchTimer) batchTimer = setTimeout(flushUrls, 30)
  })
}

export function cachedUrl(path: string): string | null {
  const c = urlCache.get(path)
  return c && c.exp > Date.now() + 60_000 ? c.url : null
}

async function flushUrls() {
  batchTimer = null
  const batch = new Map(waiting)
  waiting.clear()
  const paths = [...batch.keys()]
  for (let i = 0; i < paths.length; i += 100) {
    const part = paths.slice(i, i + 100)
    try {
      const { data, error } = await sb().storage.from(BUCKET).createSignedUrls(part, 3600)
      if (error) throw error
      for (const d of data ?? []) {
        if (d.path && d.signedUrl) urlCache.set(d.path, { url: d.signedUrl, exp: Date.now() + 3600_000 })
      }
    } catch {
      /* 아래에서 null 처리 */
    }
    for (const p of part) for (const r of batch.get(p) ?? []) r(urlCache.get(p)?.url ?? null)
  }
}

async function downloadBytes(path: string): Promise<Uint8Array> {
  const { data, error } = await sb().storage.from(BUCKET).download(path)
  if (error) throw error
  return new Uint8Array(await data.arrayBuffer())
}

/** 원본을 받아 등록 당시 SHA-256과 비교합니다. 다르면 예외. */
export async function fetchOriginal(c: Candidate): Promise<Uint8Array> {
  const bytes = await downloadBytes(c.storage_path)
  const sha = await sha256Hex(bytes)
  if (sha !== c.sha256) throw new Error(`"${c.original_name}" 원본이 등록 당시와 다릅니다(바이트 불일치)`)
  return bytes
}

// ───────────── 채택 이미지 내보내기 ─────────────

export interface ExportRow {
  reaction: Reaction
  candidate: Candidate | null
  plan: PlannedName<Reaction> | null
}

export function planExport(reactions: Reaction[], candidates: Record<string, Candidate[]>): ExportRow[] {
  const withImg = reactions
    .map((r) => ({ r, c: (candidates[r.id] ?? []).find((c) => c.id === r.adopted_candidate_id) ?? null }))
  const adopted = withImg.filter((x) => x.c)
  const plans = planExportNames(
    adopted.map(({ r, c }, i) => ({
      item: r,
      desired: r.filename || r.emotion,
      ext: c!.ext,
      fallback: `reaction-${String(i + 1).padStart(3, '0')}`,
    })),
  )
  const planById = new Map(plans.map((p) => [p.item.id, p]))
  return withImg.map(({ r, c }) => ({ reaction: r, candidate: c, plan: planById.get(r.id) ?? null }))
}

export async function exportZip(rows: ExportRow[], onProgress: Progress): Promise<Blob> {
  const list = rows.filter((x) => x.candidate && x.plan)
  const z = new ZipBuilder()
  for (const [i, x] of list.entries()) {
    onProgress(i, list.length, x.plan!.fileName)
    const bytes = await fetchOriginal(x.candidate!)
    z.addStored(x.plan!.fileName, bytes, new Date(x.candidate!.created_at))
  }
  onProgress(list.length, list.length, '압축 마무리')
  return z.finish()
}

// ───────────── 백업 ─────────────

export async function buildBackup(projectId: string, onProgress: Progress): Promise<Blob> {
  const [{ data: p, error: e1 }, { data: rs, error: e2 }, { data: cs, error: e3 }] = await Promise.all([
    sb().from('projects').select('*').eq('id', projectId).single(),
    sb().from('reactions').select('*').eq('project_id', projectId).order('sort_order'),
    sb().from('candidates').select('*').eq('project_id', projectId).order('created_at'),
  ])
  if (e1 || e2 || e3) throw e1 || e2 || e3
  const byR = new Map<string, Candidate[]>()
  for (const c of cs as Candidate[]) byR.set(c.reaction_id, [...(byR.get(c.reaction_id) ?? []), c])
  const manifest = buildManifest(p as Project, rs as Reaction[], byR)
  const z = new ZipBuilder()
  z.addText('backup.json', JSON.stringify(manifest, null, 2))
  z.addText(
    'README.txt',
    '리액션 작업실 프로젝트 백업입니다.\r\n앱의 "백업에서 복원"으로 불러오세요. backup.json과 images 폴더를 수정하면 복원이 거부될 수 있습니다.\r\n',
  )
  const all = cs as Candidate[]
  for (const [i, c] of all.entries()) {
    onProgress(i, all.length, c.original_name || c.id)
    z.addStored(`images/${c.id}.${c.ext}`, await fetchOriginal(c), new Date(c.created_at))
  }
  onProgress(all.length, all.length, '압축 마무리')
  return z.finish()
}

export { parseBackup }
export type { ParsedBackup }

/**
 * 백업을 항상 '새 프로젝트'로 복원합니다(기존 프로젝트는 건드리지 않음).
 * 중간에 실패하면 만든 프로젝트와 올린 파일을 지워 원래 상태로 되돌립니다.
 */
export async function restoreBackup(b: ParsedBackup, name: string, onProgress: Progress): Promise<string> {
  const owner = uid()
  const projectId = crypto.randomUUID()
  const uploaded: string[] = []
  let created = false
  try {
    const m = b.manifest
    const { error: pe } = await sb()
      .from('projects')
      .insert({ id: projectId, name, character_name: m.project.character_name, memo: m.project.memo })
    if (pe) throw pe
    created = true
    const rid = new Map<string, string>()
    const cid = new Map<string, string>()
    const reactionRows = m.reactions.map((r) => {
      const id = crypto.randomUUID()
      rid.set(r.id, id)
      return {
        id,
        project_id: projectId,
        sort_order: r.sort_order,
        emotion: r.emotion,
        expression: r.expression,
        visual: r.visual,
        tags: r.tags,
        tags_auto: r.tags_auto,
        keyword: r.keyword,
        filename: r.filename,
        memo: r.memo,
        status: 'todo',
      }
    })
    for (let i = 0; i < reactionRows.length; i += 200) {
      const { error } = await sb().from('reactions').insert(reactionRows.slice(i, i + 200))
      if (error) throw error
    }
    const total = b.imageCount
    let done = 0
    for (const r of m.reactions) {
      for (const c of r.candidates) {
        onProgress(done, total, c.original_name || c.id)
        const bytes = b.files.get(c.id)!
        const newId = crypto.randomUUID()
        cid.set(c.id, newId)
        const base = `${owner}/${projectId}/${rid.get(r.id)}/${newId}`
        const path = `${base}.${c.ext}`
        const { error: ue } = await sb().storage.from(BUCKET).upload(path, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: c.mime_type }), {
          contentType: c.mime_type,
          upsert: false,
        })
        if (ue) throw ue
        uploaded.push(path)
        let thumbPath: string | null = null
        const th = await makeThumbnail(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: c.mime_type }))
        if (th) {
          const tp = `${base}.thumb.${th.blob.type === 'image/webp' ? 'webp' : 'jpg'}`
          const { error } = await sb().storage.from(BUCKET).upload(tp, th.blob, { contentType: th.blob.type })
          if (!error) {
            uploaded.push(tp)
            thumbPath = tp
          }
        }
        const { error: ce } = await sb()
          .from('candidates')
          .insert({
            id: newId,
            project_id: projectId,
            reaction_id: rid.get(r.id),
            storage_path: path,
            thumb_path: thumbPath,
            original_name: c.original_name,
            mime_type: c.mime_type,
            ext: c.ext,
            byte_size: c.byte_size,
            sha256: c.sha256,
            width: c.width ?? th?.width ?? null,
            height: c.height ?? th?.height ?? null,
            memo: c.memo,
          })
        if (ce) throw ce
        done++
      }
    }
    onProgress(total, total, '상태·채택 반영')
    for (const r of m.reactions) {
      const id = rid.get(r.id)!
      const { data: cur, error: ge } = await sb().from('reactions').select('status,version').eq('id', id).single()
      if (ge) throw ge
      const status = r.status
      const adopted = r.adopted_candidate_id ? cid.get(r.adopted_candidate_id) ?? null : null
      if (cur.status === status && !adopted) continue
      const { error } = await sb()
        .from('reactions')
        .update({ status, adopted_candidate_id: adopted, version: cur.version + 1 })
        .eq('id', id)
      if (error) throw error
    }
    await loadProjects()
    return projectId
  } catch (err) {
    // 되돌리기: 새로 만든 것만 지웁니다.
    if (created) await sb().from('projects').delete().eq('id', projectId)
    if (uploaded.length) await sb().storage.from(BUCKET).remove(uploaded)
    throw err
  }
}

// ───────────── 다른 프로젝트에서 목록 복제 ─────────────

export interface CloneOptions {
  includeMemo: boolean
  includeImages: boolean
}

export async function fetchProjectReactions(projectId: string): Promise<{ reactions: Reaction[]; candidates: Candidate[] }> {
  const [{ data: rs, error: e1 }, { data: cs, error: e2 }] = await Promise.all([
    sb().from('reactions').select('*').eq('project_id', projectId).order('sort_order'),
    sb().from('candidates').select('*').eq('project_id', projectId).order('created_at'),
  ])
  if (e1 || e2) throw e1 || e2
  return { reactions: rs as Reaction[], candidates: cs as Candidate[] }
}

/**
 * 선택한 리액션을 대상 프로젝트 끝에 새 ID로 복사합니다.
 * 기본은 설계 정보만(이미지·진행 상태 제외). 원본 프로젝트와는 완전히 독립입니다.
 */
export async function cloneReactions(
  src: { reactions: Reaction[]; candidates: Candidate[] },
  ids: string[],
  targetProjectId: string,
  opt: CloneOptions,
  onProgress: Progress,
): Promise<{ created: number; imageErrors: string[] }> {
  const owner = uid()
  const chosen = src.reactions.filter((r) => ids.includes(r.id))
  const created = await createReactions(
    targetProjectId,
    chosen.map((r) => ({
      ...pickDesign(r),
      memo: opt.includeMemo ? r.memo : '',
      visual: r.visual.map((v) => ({ ...v, key: crypto.randomUUID() })),
    })),
  )
  const imageErrors: string[] = []
  if (opt.includeImages) {
    const pairs = chosen.map((r, i) => ({ from: r, to: created[i] }))
    const total = pairs.reduce((a, p) => a + src.candidates.filter((c) => c.reaction_id === p.from.id).length, 0)
    let done = 0
    for (const { from, to } of pairs) {
      const map = new Map<string, string>()
      for (const c of src.candidates.filter((c) => c.reaction_id === from.id)) {
        onProgress(done++, total, c.original_name)
        const nid = crypto.randomUUID()
        const base = `${owner}/${targetProjectId}/${to.id}/${nid}`
        const path = `${base}.${c.ext}`
        try {
          const { error } = await sb().storage.from(BUCKET).copy(c.storage_path, path)
          if (error) throw error
          let thumb: string | null = null
          if (c.thumb_path) {
            const t = `${base}.thumb.${c.thumb_path.split('.').pop()}`
            const { error: te } = await sb().storage.from(BUCKET).copy(c.thumb_path, t)
            if (!te) thumb = t
          }
          const { error: ie } = await sb().from('candidates').insert({
            id: nid,
            project_id: targetProjectId,
            reaction_id: to.id,
            storage_path: path,
            thumb_path: thumb,
            original_name: c.original_name,
            mime_type: c.mime_type,
            ext: c.ext,
            byte_size: c.byte_size,
            sha256: c.sha256,
            width: c.width,
            height: c.height,
            memo: c.memo,
          })
          if (ie) {
            await sb().storage.from(BUCKET).remove([path, ...(thumb ? [thumb] : [])])
            throw ie
          }
          map.set(c.id, nid)
        } catch (e) {
          imageErrors.push(`${from.emotion || '(이름 없음)'} / ${c.original_name}: ${(e as Error).message}`)
        }
      }
      // 진행 상태·채택 복사
      const adopted = from.adopted_candidate_id ? map.get(from.adopted_candidate_id) ?? null : null
      let status = from.status
      if (status === 'adopted' && !adopted) status = map.size ? 'generated' : 'todo'
      const { data: cur } = await sb().from('reactions').select('version,status').eq('id', to.id).single()
      if (cur && (cur.status !== status || adopted)) {
        await sb()
          .from('reactions')
          .update({ status, adopted_candidate_id: adopted, version: cur.version + 1 })
          .eq('id', to.id)
      }
    }
  }
  if (getState().currentProjectId === targetProjectId) await refreshProject()
  return { created: created.length, imageErrors }
}

// ───────────── 저장 공간 점검 ─────────────

export interface StorageReport {
  files: number
  bytes: number
  orphans: string[]
  missing: Candidate[]
}

async function listAll(prefix: string, out: { name: string; size: number }[]) {
  let offset = 0
  for (;;) {
    const { data, error } = await sb().storage.from(BUCKET).list(prefix, { limit: 1000, offset })
    if (error) throw error
    for (const it of data ?? []) {
      const full = `${prefix}/${it.name}`
      if (it.id === null || !it.metadata) await listAll(full, out)
      else out.push({ name: full, size: Number((it.metadata as { size?: number })?.size ?? 0) })
    }
    if (!data || data.length < 1000) break
    offset += 1000
  }
}

export async function checkStorage(): Promise<StorageReport> {
  const owner = uid()
  const files: { name: string; size: number }[] = []
  await listAll(owner, files)
  const { data, error } = await sb().from('candidates').select('*')
  if (error) throw error
  const cands = data as Candidate[]
  const known = new Set(pathsOf(cands))
  const present = new Set(files.map((f) => f.name))
  return {
    files: files.length,
    bytes: files.reduce((a, f) => a + f.size, 0),
    orphans: files.map((f) => f.name).filter((n) => !known.has(n)),
    missing: cands.filter((c) => !present.has(c.storage_path)),
  }
}

export async function removeOrphans(paths: string[]) {
  await removeFiles(paths)
}

export function currentProjectView() {
  const s = getState()
  const e = s.currentProjectId ? s.projects[s.currentProjectId] : null
  return e ? view(e) : null
}

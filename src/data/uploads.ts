// 이미지 업로드 대기열. 원본 파일은 그대로(재인코딩 없이) 올리고, 목록용 썸네일만 따로 만듭니다.
// 서버에 파일과 기록이 모두 저장된 뒤에만 '완료'로 표시합니다. 업로드 전 파일은 이 기기 IndexedDB에 보관해
// 새로고침 후에도 다시 시도할 수 있습니다.
import { useSyncExternalStore } from 'react'
import { createStore, get, set, del, entries } from 'idb-keyval'
import { sb } from '../supabase'
import { BUCKET } from '../config'
import { sniffFile } from '../lib/format'
import { sha256Hex } from '../lib/hash'
import { makeThumbnail } from '../lib/thumb'
import type { Candidate } from '../types'
import { addCandidateLocal, errMsg, getState, refreshReaction, toast } from './store'

export type UploadState = 'queued' | 'uploading' | 'done' | 'failed'

export interface UploadItem {
  id: string // 후보 ID와 같음
  userId: string
  projectId: string
  reactionId: string
  name: string
  size: number
  state: UploadState
  stage: string
  error: string | null
  /** 다시 시도해도 소용없는 오류(형식 불가 등) */
  fatal: boolean
  createdAt: number
}

const idb = typeof indexedDB !== 'undefined' ? createStore('nra-uploads', 'files') : null

let items: UploadItem[] = []
const listeners = new Set<() => void>()
function emit() {
  items = [...items]
  for (const l of listeners) l()
}
function update(id: string, p: Partial<UploadItem>) {
  items = items.map((x) => (x.id === id ? { ...x, ...p } : x))
  for (const l of listeners) l()
  const it = items.find((x) => x.id === id)
  if (it && idb && it.state !== 'done') void get(id, idb).then((rec) => rec && set(id, { ...rec, meta: it }, idb))
}

export function useUploads(): UploadItem[] {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => items,
  )
}

export function uploadsFor(reactionId: string) {
  return items.filter((x) => x.reactionId === reactionId && x.state !== 'done')
}

export function uploadSummary(list: UploadItem[]) {
  return {
    active: list.filter((x) => x.state === 'queued' || x.state === 'uploading').length,
    failed: list.filter((x) => x.state === 'failed').length,
  }
}

/** 이전 세션에서 끝나지 않은 업로드를 불러옵니다(중단된 것은 '실패'로 표시). */
export async function restoreUploads(userId: string) {
  if (!idb) return
  try {
    const all = await entries<string, { meta: UploadItem; blob: Blob }>(idb)
    const mine = all.map(([, v]) => v.meta).filter((m) => m && m.userId === userId)
    for (const m of mine) {
      if (items.some((x) => x.id === m.id)) continue
      items.push({ ...m, state: 'failed', stage: '', error: m.error ?? '앱이 닫혀 업로드가 중단되었습니다', fatal: !!m.fatal })
    }
    emit()
  } catch {
    /* IndexedDB 사용 불가: 메모리에서만 재시도 */
  }
}

const memBlobs = new Map<string, Blob>()

export async function enqueue(projectId: string, reactionId: string, files: File[]) {
  const userId = getState().session?.user.id
  if (!userId) return
  for (const f of files) {
    const id = crypto.randomUUID()
    const it: UploadItem = {
      id,
      userId,
      projectId,
      reactionId,
      name: f.name || 'image',
      size: f.size,
      state: 'queued',
      stage: '대기',
      error: null,
      fatal: false,
      createdAt: Date.now(),
    }
    memBlobs.set(id, f)
    items.push(it)
    if (idb) {
      try {
        await set(id, { meta: it, blob: f }, idb)
      } catch {
        /* 기기 저장 실패해도 메모리 업로드는 진행 */
      }
    }
  }
  emit()
  pump()
}

export function retry(id: string) {
  const it = items.find((x) => x.id === id)
  if (!it || it.state === 'uploading') return
  update(id, { state: 'queued', stage: '대기', error: null })
  pump()
}

export async function discard(id: string) {
  items = items.filter((x) => x.id !== id)
  memBlobs.delete(id)
  emit()
  if (idb) await del(id, idb).catch(() => undefined)
}

let running = 0
const CONCURRENCY = 2

function pump() {
  while (running < CONCURRENCY) {
    const next = items.find((x) => x.state === 'queued')
    if (!next) return
    running++
    update(next.id, { state: 'uploading', stage: '준비' })
    void run(next.id).finally(() => {
      running--
      pump()
    })
  }
}

async function blobOf(id: string): Promise<Blob | null> {
  const m = memBlobs.get(id)
  if (m) return m
  if (!idb) return null
  const rec = await get<{ blob: Blob }>(id, idb).catch(() => undefined)
  return rec?.blob ?? null
}

class Fatal extends Error {}

async function run(id: string) {
  const it = items.find((x) => x.id === id)
  if (!it) return
  try {
    const blob = await blobOf(id)
    if (!blob) throw new Fatal('기기에 보관된 파일을 찾을 수 없습니다. 다시 선택해 주세요.')
    const fmt = await sniffFile(blob)
    if (!fmt) throw new Fatal('PNG·JPEG·WEBP·GIF·AVIF 이미지만 등록할 수 있습니다')
    update(id, { stage: '확인 중' })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const sha = await sha256Hex(bytes)
    const base = `${it.userId}/${it.projectId}/${it.reactionId}/${id}`
    const storagePath = `${base}.${fmt.ext}`

    update(id, { stage: '원본 업로드' })
    // 원본 바이트를 그대로 올립니다(Blob을 새로 만들어 MIME만 실제 형식으로 지정).
    const { error: upErr } = await sb()
      .storage.from(BUCKET)
      .upload(storagePath, new Blob([bytes], { type: fmt.mime }), { contentType: fmt.mime, upsert: true, cacheControl: '31536000' })
    if (upErr) throw upErr

    update(id, { stage: '썸네일' })
    let thumbPath: string | null = null
    let width: number | null = null
    let height: number | null = null
    const th = await makeThumbnail(blob)
    if (th) {
      width = th.width
      height = th.height
      const tExt = th.blob.type === 'image/webp' ? 'webp' : 'jpg'
      const p = `${base}.thumb.${tExt}`
      const { error } = await sb().storage.from(BUCKET).upload(p, th.blob, { contentType: th.blob.type, upsert: true, cacheControl: '31536000' })
      if (!error) thumbPath = p
    }

    update(id, { stage: '기록 저장' })
    const row = {
      id,
      project_id: it.projectId,
      reaction_id: it.reactionId,
      storage_path: storagePath,
      thumb_path: thumbPath,
      original_name: it.name.slice(0, 500),
      mime_type: fmt.mime,
      ext: fmt.ext,
      byte_size: bytes.length,
      sha256: sha,
      width,
      height,
    }
    let cand: Candidate
    const { data, error } = await sb().from('candidates').insert(row).select().single()
    if (error) {
      // 이전 시도에서 이미 기록됐는데 응답만 못 받은 경우
      const { data: ex } = await sb().from('candidates').select('*').eq('id', id).maybeSingle()
      if (!ex) {
        if (error.code === '23503') throw new Fatal('리액션이 삭제되어 이미지를 등록할 수 없습니다')
        throw error
      }
      cand = ex as Candidate
    } else cand = data as Candidate

    if (getState().currentProjectId === it.projectId) {
      addCandidateLocal(cand)
      await refreshReaction(it.reactionId)
    }
    update(id, { state: 'done', stage: '완료', error: null })
    memBlobs.delete(id)
    if (idb) await del(id, idb).catch(() => undefined)
    setTimeout(() => {
      items = items.filter((x) => x.id !== id)
      emit()
    }, 1500)
  } catch (err) {
    const fatal = err instanceof Fatal
    update(id, { state: 'failed', stage: '', error: fatal ? (err as Error).message : errMsg(err), fatal })
    if (!fatal) toast(`업로드 실패: ${it.name} — ${errMsg(err)}`, 'error')
  }
}

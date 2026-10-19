// 앱 상태와 서버 동기화.
// - 프로젝트·리액션은 version 열로 낙관적 잠금을 겁니다. 오래된 화면에서 저장하면 서버가 0행을 돌려주고,
//   서로 다른 필드면 자동 병합, 같은 필드를 다르게 고쳤으면 충돌로 보여 줍니다.
// - 편집 중 내용은 저장이 끝날 때까지 이 기기(localStorage)에 임시 보관합니다.
import { useSyncExternalStore } from 'react'
import type { Session } from '@supabase/supabase-js'
import { sb } from '../supabase'
import { BUCKET } from '../config'
import type { Candidate, Project, Reaction, Status, VisualOption } from '../types'
import { PROJECT_EDITABLE, REACTION_EDITABLE } from '../types'
import { same, threeWayMerge } from '../lib/merge'
import { orderBetween } from '../lib/order'

export type Table = 'projects' | 'reactions'
type Row = Project | Reaction

export interface Entity<T> {
  base: T
  local: Partial<T>
  saving: boolean
  error: string | null
  /** 충돌 필드. 값이 있으면 사용자가 정할 때까지 저장하지 않습니다. */
  conflict: string[] | null
  conflictReason?: string
  deleted?: boolean
}

export interface Toast {
  id: number
  kind: 'info' | 'error' | 'ok'
  text: string
}

export type Counts = Record<Status | 'total', number>

export interface State {
  session: Session | null
  authReady: boolean
  online: boolean
  projects: Record<string, Entity<Project>>
  projectsLoaded: boolean
  projectStats: Record<string, Counts>
  currentProjectId: string | null
  projectLoading: boolean
  reactions: Record<string, Entity<Reaction>>
  candidates: Record<string, Candidate[]>
  options: VisualOption[]
  lastSync: number | null
  syncError: string | null
  toasts: Toast[]
}

const initial: State = {
  session: null,
  authReady: false,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  projects: {},
  projectsLoaded: false,
  projectStats: {},
  currentProjectId: null,
  projectLoading: false,
  reactions: {},
  candidates: {},
  options: [],
  lastSync: null,
  syncError: null,
  toasts: [],
}

let state: State = initial
const listeners = new Set<() => void>()

export function getState() {
  return state
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...p }
  for (const l of listeners) l()
}

export function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state))
}

export function view<T>(e: Entity<T>): T {
  return { ...e.base, ...e.local }
}

export function uid(): string {
  const id = state.session?.user.id
  if (!id) throw new Error('로그인이 필요합니다')
  return id
}

// ───────────── 알림 ─────────────

let toastSeq = 1
export function toast(text: string, kind: Toast['kind'] = 'info', ms = kind === 'error' ? 8000 : 3500) {
  const id = toastSeq++
  setState((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms)
}

export function errMsg(e: unknown): string {
  if (!e) return '알 수 없는 오류'
  const anyE = e as { message?: string; code?: string; details?: string; status?: number; statusCode?: string }
  const m = anyE.message ?? String(e)
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) return '네트워크 연결을 확인하세요'
  if (anyE.code === '23503') return '연결된 항목이 없거나 다른 기기에서 삭제되었습니다'
  if (anyE.code === '23514') return '저장할 수 없는 값입니다(상태·채택 불일치 또는 길이 초과)'
  if (anyE.code === '42501' || /row-level security|permission denied/i.test(m)) return '접근 권한이 없습니다(로그인 상태를 확인하세요)'
  if (/JWT|token/i.test(m) && /expired|invalid/i.test(m)) return '로그인이 만료되었습니다. 다시 로그인하세요'
  return m
}

function isNetworkError(e: unknown) {
  const m = (e as { message?: string })?.message ?? ''
  return /Failed to fetch|NetworkError|Load failed|network|timeout/i.test(m) || !navigator.onLine
}

// ───────────── 정규화 ─────────────

function normReaction(r: Reaction): Reaction {
  return { ...r, visual: Array.isArray(r.visual) ? r.visual : [], sort_order: Number(r.sort_order) }
}
function normRow(table: Table, r: Row): Row {
  return table === 'reactions' ? normReaction(r as Reaction) : r
}

function entityMap(table: Table): Record<string, Entity<Row>> {
  return (table === 'projects' ? state.projects : state.reactions) as Record<string, Entity<Row>>
}

function putEntity(table: Table, id: string, e: Entity<Row> | null) {
  const key = table === 'projects' ? 'projects' : 'reactions'
  setState((s) => {
    const m = { ...(s[key] as Record<string, Entity<Row>>) }
    if (e) m[id] = e
    else delete m[id]
    return { [key]: m } as Partial<State>
  })
}

function patchEntity(table: Table, id: string, p: Partial<Entity<Row>>) {
  const e = entityMap(table)[id]
  if (!e) return
  putEntity(table, id, { ...e, ...p })
}

// ───────────── 기기 내 임시 저장 ─────────────

const draftKey = (table: Table, id: string) => `nra:draft:${state.session?.user.id ?? 'anon'}:${table}:${id}`

function saveDraft(table: Table, id: string, e: Entity<Row>) {
  try {
    if (!Object.keys(e.local).length) localStorage.removeItem(draftKey(table, id))
    else localStorage.setItem(draftKey(table, id), JSON.stringify({ v: e.base.version, local: e.local, at: Date.now() }))
  } catch {
    /* 저장 공간 부족 등: 서버 저장은 계속 시도 */
  }
}

function readDraft(table: Table, id: string): { v: number; local: Record<string, unknown> } | null {
  try {
    const raw = localStorage.getItem(draftKey(table, id))
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function dropDraft(table: Table, id: string) {
  try {
    localStorage.removeItem(draftKey(table, id))
  } catch {
    /* 무시 */
  }
}

/** 서버에서 받은 행에 이 기기의 임시 저장본을 다시 얹습니다. */
function withDraft(table: Table, row: Row): Entity<Row> {
  const e: Entity<Row> = { base: row, local: {}, saving: false, error: null, conflict: null }
  const d = readDraft(table, row.id)
  if (!d) return e
  const local: Record<string, unknown> = {}
  const allowed: readonly string[] = table === 'projects' ? PROJECT_EDITABLE : REACTION_EDITABLE
  for (const [k, v] of Object.entries(d.local ?? {})) {
    if (!allowed.includes(k)) continue
    if (!same((row as unknown as Record<string, unknown>)[k], v)) local[k] = v
  }
  if (!Object.keys(local).length) {
    dropDraft(table, row.id)
    return e
  }
  e.local = local as Partial<Row>
  if (d.v !== row.version) {
    // 임시 저장 이후 다른 곳에서 수정됨 → 어느 값을 쓸지 사용자가 결정
    e.conflict = Object.keys(local)
    e.conflictReason = '이 기기에 저장되지 않은 수정 내용이 남아 있는데, 그 사이 다른 기기에서도 수정되었습니다.'
  }
  return e
}

// ───────────── 저장(낙관적 잠금) ─────────────

const timers = new Map<string, ReturnType<typeof setTimeout>>()
const inflight = new Set<string>()
const again = new Set<string>()
const retryDelay = new Map<string, number>()

const k = (table: Table, id: string) => `${table}:${id}`

export function edit<T extends Row>(table: Table, id: string, patch: Partial<T>, delay = 700) {
  const e = entityMap(table)[id]
  if (!e || e.deleted) return
  const local: Record<string, unknown> = { ...(e.local as Record<string, unknown>) }
  for (const [f, v] of Object.entries(patch)) {
    if (same((e.base as unknown as Record<string, unknown>)[f], v)) delete local[f]
    else local[f] = v
  }
  const ne = { ...e, local: local as Partial<Row>, error: null }
  putEntity(table, id, ne)
  saveDraft(table, id, ne)
  schedule(table, id, delay)
}

function schedule(table: Table, id: string, delay: number) {
  const key = k(table, id)
  clearTimeout(timers.get(key))
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      void flush(table, id)
    }, delay),
  )
}

export async function flush(table: Table, id: string): Promise<void> {
  const key = k(table, id)
  if (inflight.has(key)) {
    again.add(key)
    return
  }
  const e = entityMap(table)[id]
  if (!e || e.deleted || e.conflict || !Object.keys(e.local).length) return
  const sent = { ...(e.local as Record<string, unknown>) }
  const base = e.base
  inflight.add(key)
  patchEntity(table, id, { saving: true })
  try {
    const { data, error } = await sb()
      .from(table)
      .update({ ...sent, version: base.version + 1 })
      .eq('id', id)
      .eq('version', base.version)
      .select()
      .maybeSingle()
    if (error) throw error
    if (data) {
      const cur = entityMap(table)[id]
      const local = { ...(cur?.local as Record<string, unknown>) }
      for (const f of Object.keys(sent)) if (same(local[f], sent[f])) delete local[f]
      const ne: Entity<Row> = { ...(cur ?? e), base: normRow(table, data as Row), local: local as Partial<Row>, saving: false, error: null }
      putEntity(table, id, ne)
      saveDraft(table, id, ne)
      retryDelay.delete(key)
      setState({ lastSync: Date.now(), syncError: null })
      if (table === 'reactions') bumpStats()
    } else {
      // 버전 불일치: 다른 기기에서 먼저 수정됨(또는 삭제됨)
      const { data: server, error: e2 } = await sb().from(table).select('*').eq('id', id).maybeSingle()
      if (e2) throw e2
      const cur = entityMap(table)[id] ?? e
      if (!server) {
        putEntity(table, id, { ...cur, saving: false, deleted: true, error: '다른 기기에서 삭제된 항목입니다' })
        dropDraft(table, id)
        return
      }
      const srv = normRow(table, server as Row)
      const m = threeWayMerge(
        base as unknown as Record<string, unknown>,
        srv as unknown as Record<string, unknown>,
        cur.local as Record<string, unknown>,
      )
      if (!m.conflicts.length) {
        const ne = { ...cur, base: srv, local: m.rebased as Partial<Row>, saving: false }
        putEntity(table, id, ne)
        saveDraft(table, id, ne)
        again.add(key)
      } else {
        const local = { ...m.rebased }
        for (const f of m.conflicts) local[f] = (cur.local as Record<string, unknown>)[f]
        const ne: Entity<Row> = {
          ...cur,
          base: srv,
          local: local as Partial<Row>,
          saving: false,
          conflict: m.conflicts,
          conflictReason: '다른 기기에서 같은 항목을 먼저 수정했습니다.',
        }
        putEntity(table, id, ne)
        saveDraft(table, id, ne)
      }
    }
  } catch (err) {
    const msg = errMsg(err)
    patchEntity(table, id, { saving: false, error: msg })
    setState({ syncError: msg })
    if (isNetworkError(err)) {
      const d = Math.min((retryDelay.get(key) ?? 1000) * 2, 60_000)
      retryDelay.set(key, d)
      schedule(table, id, d)
    }
  } finally {
    inflight.delete(key)
    if (again.has(key)) {
      again.delete(key)
      void flush(table, id)
    }
  }
}

/** 충돌 해결: choice[field] = 'mine' | 'server' */
export function resolveConflict(table: Table, id: string, choice: Record<string, 'mine' | 'server'>) {
  const e = entityMap(table)[id]
  if (!e) return
  const local = { ...(e.local as Record<string, unknown>) }
  if ('tags' in choice && !('tags_auto' in choice)) choice = { ...choice, tags_auto: choice.tags }
  for (const f of e.conflict ?? []) if (choice[f] !== 'mine') delete local[f]
  // 연결 필드는 함께 처리(상태/채택)
  if ('status' in choice || 'adopted_candidate_id' in choice) {
    const pick = choice.status ?? choice.adopted_candidate_id
    if (pick === 'server') {
      delete local.status
      delete local.adopted_candidate_id
    }
  }
  const ne: Entity<Row> = { ...e, local: local as Partial<Row>, conflict: null, conflictReason: undefined, error: null }
  putEntity(table, id, ne)
  saveDraft(table, id, ne)
  void flush(table, id)
}

/** 저장 실패한 내 변경을 버리고 서버 값으로 되돌립니다. */
export function discardLocal(table: Table, id: string) {
  const e = entityMap(table)[id]
  if (!e) return
  const ne: Entity<Row> = { ...e, local: {}, conflict: null, error: null }
  putEntity(table, id, ne)
  dropDraft(table, id)
  if (e.deleted) putEntity(table, id, null)
}

export function flushAll() {
  for (const [id, e] of Object.entries(state.projects)) if (Object.keys(e.local).length) void flush('projects', id)
  for (const [id, e] of Object.entries(state.reactions)) if (Object.keys(e.local).length) void flush('reactions', id)
}

export function pendingSummary(s: State) {
  let pending = 0
  let saving = 0
  let failed = 0
  let conflicts = 0
  for (const e of [...Object.values(s.projects), ...Object.values(s.reactions)] as Entity<Row>[]) {
    if (e.conflict) conflicts++
    else if (e.error) failed++
    else if (e.saving) saving++
    else if (Object.keys(e.local).length) pending++
  }
  return { pending, saving, failed, conflicts }
}

/** 서버에서 새로 받은 행을 반영합니다. 편집 중이면 내 변경을 그 위로 옮깁니다. */
export function absorb(table: Table, row: Row) {
  const srv = normRow(table, row)
  const e = entityMap(table)[srv.id]
  if (!e) {
    putEntity(table, srv.id, withDraft(table, srv))
    return
  }
  if (e.base.version === srv.version && same(e.base, srv)) return
  if (!Object.keys(e.local).length) {
    putEntity(table, srv.id, { ...e, base: srv, error: null })
    return
  }
  if (e.saving || e.conflict) return
  const m = threeWayMerge(
    e.base as unknown as Record<string, unknown>,
    srv as unknown as Record<string, unknown>,
    e.local as Record<string, unknown>,
  )
  if (!m.conflicts.length) {
    const ne = { ...e, base: srv, local: m.rebased as Partial<Row> }
    putEntity(table, srv.id, ne)
    saveDraft(table, srv.id, ne)
  } else {
    const local = { ...m.rebased }
    for (const f of m.conflicts) local[f] = (e.local as Record<string, unknown>)[f]
    putEntity(table, srv.id, {
      ...e,
      base: srv,
      local: local as Partial<Row>,
      conflict: m.conflicts,
      conflictReason: '다른 기기에서 같은 항목을 수정했습니다.',
    })
  }
}

// ───────────── 인증 ─────────────

export async function initAuth() {
  const { data } = await sb().auth.getSession()
  setState({ session: data.session, authReady: true })
  sb().auth.onAuthStateChange((_ev, session) => {
    const prev = state.session?.user.id
    setState({ session })
    if (session && session.user.id !== prev) void loadProjects()
    if (!session) setState({ ...initial, authReady: true, online: state.online })
  })
  if (data.session) void loadProjects()
}

export async function signIn(email: string, password: string) {
  const { error } = await sb().auth.signInWithPassword({ email: email.trim(), password })
  if (error) throw error
}

export async function signOut() {
  const p = pendingSummary(state)
  if (p.pending + p.saving + p.failed + p.conflicts > 0) {
    if (!confirm('아직 저장되지 않은 수정이 있습니다. 로그아웃하면 이 기기의 임시 저장본만 남습니다. 계속할까요?')) return
  }
  await sb().auth.signOut()
}

// ───────────── 프로젝트 ─────────────

export async function loadProjects() {
  try {
    const [{ data: ps, error: e1 }, { data: rs, error: e2 }, { data: os, error: e3 }] = await Promise.all([
      sb().from('projects').select('*').order('updated_at', { ascending: false }),
      sb().from('reactions').select('project_id,status'),
      sb().from('visual_options').select('*').order('category').order('sort_order'),
    ])
    if (e1 || e2 || e3) throw e1 || e2 || e3
    const projects: Record<string, Entity<Project>> = {}
    for (const p of ps as Project[]) {
      const prev = state.projects[p.id]
      if (prev && (Object.keys(prev.local).length || prev.saving || prev.conflict)) {
        projects[p.id] = prev
        absorbLater.push(p)
      } else projects[p.id] = withDraft('projects', p) as Entity<Project>
    }
    const stats: Record<string, Counts> = {}
    for (const r of rs as { project_id: string; status: Status }[]) {
      const c = (stats[r.project_id] ??= { total: 0, todo: 0, generated: 0, rework: 0, adopted: 0 })
      c.total++
      c[r.status]++
    }
    setState({ projects, projectStats: stats, projectsLoaded: true, options: os as VisualOption[], lastSync: Date.now(), syncError: null })
    for (const p of absorbLater.splice(0)) absorb('projects', p)
    for (const [id, e] of Object.entries(projects)) if (Object.keys(e.local).length && !e.conflict) schedule('projects', id, 300)
  } catch (err) {
    setState({ projectsLoaded: true, syncError: errMsg(err) })
    toast(`프로젝트 목록을 불러오지 못했습니다: ${errMsg(err)}`, 'error')
  }
}
const absorbLater: Project[] = []

function bumpStats() {
  const pid = state.currentProjectId
  if (!pid) return
  const c: Counts = { total: 0, todo: 0, generated: 0, rework: 0, adopted: 0 }
  for (const e of Object.values(state.reactions)) {
    if (e.deleted) continue
    c.total++
    c[view(e).status]++
  }
  setState((s) => ({ projectStats: { ...s.projectStats, [pid]: c } }))
}

export async function createProject(name: string, character: string, memo = ''): Promise<string> {
  const { data, error } = await sb()
    .from('projects')
    .insert({ id: crypto.randomUUID(), name: name.trim(), character_name: character.trim(), memo })
    .select()
    .single()
  if (error) throw error
  putEntity('projects', data.id, withDraft('projects', data as Project))
  setState((s) => ({ projectStats: { ...s.projectStats, [data.id]: { total: 0, todo: 0, generated: 0, rework: 0, adopted: 0 } } }))
  return data.id
}

/** 프로젝트와 소속 이미지 파일까지 삭제합니다. */
export async function deleteProject(id: string) {
  const { data: cands, error: e0 } = await sb().from('candidates').select('storage_path,thumb_path').eq('project_id', id)
  if (e0) throw e0
  const { error } = await sb().from('projects').delete().eq('id', id)
  if (error) throw error
  dropDraft('projects', id)
  putEntity('projects', id, null)
  if (state.currentProjectId === id) setState({ currentProjectId: null, reactions: {}, candidates: {} })
  await removeFiles(pathsOf(cands as Pick<Candidate, 'storage_path' | 'thumb_path'>[]))
}

export async function openProject(id: string | null) {
  if (id === state.currentProjectId && id) {
    void refreshProject()
    return
  }
  setState({ currentProjectId: id, reactions: {}, candidates: {}, projectLoading: !!id })
  if (id) await refreshProject(true)
}

/** 현재 프로젝트를 서버에서 다시 읽습니다(다른 기기의 변경 반영). */
export async function refreshProject(first = false) {
  const pid = state.currentProjectId
  if (!pid) return
  try {
    const [{ data: p, error: e1 }, { data: rs, error: e2 }, { data: cs, error: e3 }] = await Promise.all([
      sb().from('projects').select('*').eq('id', pid).maybeSingle(),
      sb().from('reactions').select('*').eq('project_id', pid).order('sort_order'),
      sb().from('candidates').select('*').eq('project_id', pid).order('created_at'),
    ])
    if (e1 || e2 || e3) throw e1 || e2 || e3
    if (state.currentProjectId !== pid) return
    if (!p) {
      toast('프로젝트가 삭제되었거나 접근할 수 없습니다', 'error')
      putEntity('projects', pid, null)
      setState({ currentProjectId: null, projectLoading: false })
      return
    }
    absorb('projects', p as Project)
    const seen = new Set<string>()
    for (const r of rs as Reaction[]) {
      seen.add(r.id)
      absorb('reactions', r)
    }
    // 다른 기기에서 삭제된 리액션 정리(편집 중이 아니면 조용히, 편집 중이면 표시)
    for (const [id, e] of Object.entries(state.reactions)) {
      if (seen.has(id)) continue
      if (Object.keys(e.local).length) patchEntity('reactions', id, { deleted: true, error: '다른 기기에서 삭제된 항목입니다' })
      else putEntity('reactions', id, null)
    }
    const byR: Record<string, Candidate[]> = {}
    for (const c of cs as Candidate[]) (byR[c.reaction_id] ??= []).push(c)
    setState({ candidates: byR, projectLoading: false, lastSync: Date.now(), syncError: null })
    bumpStats()
    if (first) for (const [id, e] of Object.entries(state.reactions)) if (Object.keys(e.local).length && !e.conflict) schedule('reactions', id, 300)
  } catch (err) {
    setState({ projectLoading: false, syncError: errMsg(err) })
    if (first) toast(`프로젝트를 불러오지 못했습니다: ${errMsg(err)}`, 'error')
  }
}

// ───────────── 리액션 ─────────────

export function sortedReactions(s: State): Entity<Reaction>[] {
  return Object.values(s.reactions)
    .filter((e) => !e.deleted || Object.keys(e.local).length)
    .sort((a, b) => view(a).sort_order - view(b).sort_order || a.base.created_at.localeCompare(b.base.created_at))
}

type ReactionDesign = Pick<Reaction, 'emotion' | 'expression' | 'visual' | 'tags' | 'tags_auto' | 'keyword' | 'filename' | 'memo'>

export async function createReactions(projectId: string, items: Partial<ReactionDesign>[], afterId?: string): Promise<Reaction[]> {
  const list = sortedReactions(state).map(view)
  let prev: number | undefined
  let next: number | undefined
  if (afterId) {
    const i = list.findIndex((r) => r.id === afterId)
    prev = list[i]?.sort_order
    next = list[i + 1]?.sort_order
  } else {
    prev = list.length ? list[list.length - 1].sort_order : undefined
  }
  const rows = items.map((it, i) => {
    let so: number
    if (next === undefined) so = (prev ?? 0) + 1024 * (i + 1)
    else {
      const lo = prev ?? next - 1024
      so = lo + ((next - lo) * (i + 1)) / (items.length + 1)
    }
    return {
      id: crypto.randomUUID(),
      project_id: projectId,
      sort_order: so,
      emotion: it.emotion ?? '',
      expression: it.expression ?? '',
      visual: it.visual ?? [],
      tags: it.tags ?? '',
      tags_auto: it.tags_auto ?? '',
      keyword: it.keyword ?? '',
      filename: it.filename ?? '',
      memo: it.memo ?? '',
    }
  })
  const out: Reaction[] = []
  for (let i = 0; i < rows.length; i += 200) {
    const { data, error } = await sb().from('reactions').insert(rows.slice(i, i + 200)).select()
    if (error) throw error
    out.push(...(data as Reaction[]))
  }
  if (state.currentProjectId === projectId) {
    for (const r of out) putEntity('reactions', r.id, withDraft('reactions', normReaction(r)))
    bumpStats()
  }
  return out.map(normReaction)
}

export async function duplicateReaction(id: string) {
  const e = state.reactions[id]
  if (!e) return
  const r = view(e)
  const [n] = await createReactions(
    r.project_id,
    [{ ...pickDesign(r), emotion: r.emotion ? `${r.emotion} (복제)` : '(복제)', visual: r.visual.map((v) => ({ ...v, key: crypto.randomUUID() })) }],
    id,
  )
  return n
}

export function pickDesign(r: Reaction): ReactionDesign {
  return {
    emotion: r.emotion,
    expression: r.expression,
    visual: r.visual,
    tags: r.tags,
    tags_auto: r.tags_auto,
    keyword: r.keyword,
    filename: r.filename,
    memo: r.memo,
  }
}

export async function deleteReactions(ids: string[]) {
  if (!ids.length) return
  const paths = pathsOf(ids.flatMap((id) => state.candidates[id] ?? []))
  const { error } = await sb().from('reactions').delete().in('id', ids)
  if (error) throw error
  setState((s) => {
    const reactions = { ...s.reactions }
    const candidates = { ...s.candidates }
    for (const id of ids) {
      delete reactions[id]
      delete candidates[id]
      dropDraft('reactions', id)
    }
    return { reactions, candidates }
  })
  bumpStats()
  await removeFiles(paths)
}

/** 여러 리액션 상태 변경. 채택 이미지가 있는 리액션을 다른 상태로 바꾸면 채택이 해제됩니다. */
export function setStatusBulk(ids: string[], status: Exclude<Status, 'adopted'>) {
  for (const id of ids) {
    const e = state.reactions[id]
    if (!e) continue
    edit<Reaction>('reactions', id, { status, adopted_candidate_id: null }, 100)
  }
}

export function setStatus(id: string, status: Status) {
  const e = state.reactions[id]
  if (!e) return
  if (status === 'adopted') return // 채택은 이미지를 골라야 함(adopt 사용)
  edit<Reaction>('reactions', id, { status, adopted_candidate_id: null }, 100)
}

export function adopt(reactionId: string, candidateId: string | null) {
  const e = state.reactions[reactionId]
  if (!e) return
  if (candidateId) edit<Reaction>('reactions', reactionId, { status: 'adopted', adopted_candidate_id: candidateId }, 50)
  else {
    const n = (state.candidates[reactionId] ?? []).length
    edit<Reaction>('reactions', reactionId, { status: n ? 'generated' : 'todo', adopted_candidate_id: null }, 50)
  }
}

export function moveReaction(id: string, targetIndex: number) {
  const list = sortedReactions(state).map(view).filter((r) => r.id !== id)
  const t = Math.max(0, Math.min(targetIndex, list.length))
  const so = orderBetween(list[t - 1]?.sort_order, list[t]?.sort_order)
  edit<Reaction>('reactions', id, { sort_order: so }, 300)
}

// ───────────── 후보 이미지 ─────────────

export function pathsOf(cs: Pick<Candidate, 'storage_path' | 'thumb_path'>[]): string[] {
  return cs.flatMap((c) => [c.storage_path, c.thumb_path].filter(Boolean) as string[])
}

export async function removeFiles(paths: string[]) {
  for (let i = 0; i < paths.length; i += 900) {
    const { error } = await sb().storage.from(BUCKET).remove(paths.slice(i, i + 900))
    if (error) {
      toast(`기록은 삭제했지만 일부 이미지 파일을 지우지 못했습니다. 설정 → 저장 공간 점검에서 정리할 수 있습니다. (${errMsg(error)})`, 'error')
      return
    }
  }
}

export function addCandidateLocal(c: Candidate) {
  setState((s) => {
    const list = (s.candidates[c.reaction_id] ?? []).filter((x) => x.id !== c.id)
    return { candidates: { ...s.candidates, [c.reaction_id]: [...list, c] } }
  })
}

/** 리액션 한 개를 서버에서 다시 읽어 반영(트리거가 바꾼 상태 등) */
export async function refreshReaction(id: string) {
  const { data, error } = await sb().from('reactions').select('*').eq('id', id).maybeSingle()
  if (error || !data) return
  absorb('reactions', data as Reaction)
  bumpStats()
}

export async function deleteCandidate(c: Candidate) {
  const { error } = await sb().from('candidates').delete().eq('id', c.id)
  if (error) throw error
  setState((s) => ({ candidates: { ...s.candidates, [c.reaction_id]: (s.candidates[c.reaction_id] ?? []).filter((x) => x.id !== c.id) } }))
  // 채택 해제·상태 변경은 서버 트리거가 처리하므로 최신 값을 받아 옵니다.
  await refreshReaction(c.reaction_id)
  await removeFiles(pathsOf([c]))
}

export async function updateCandidateMemo(c: Candidate, memo: string) {
  const { data, error } = await sb().from('candidates').update({ memo }).eq('id', c.id).select().maybeSingle()
  if (error) throw error
  if (!data) throw new Error('다른 기기에서 삭제된 이미지입니다')
  addCandidateLocal(data as Candidate)
}

// ───────────── 선택 항목 라이브러리 ─────────────

export async function saveOption(o: Partial<VisualOption> & { category: string }) {
  const row = { id: o.id ?? crypto.randomUUID(), category: o.category, label: o.label ?? '', tag: o.tag ?? '', sort_order: o.sort_order ?? Date.now() }
  const { data, error } = await sb().from('visual_options').upsert(row).select().single()
  if (error) throw error
  setState((s) => ({ options: [...s.options.filter((x) => x.id !== data.id), data as VisualOption] }))
  return data as VisualOption
}

export async function saveOptions(rows: { category: string; label: string; tag: string }[]) {
  const base = Date.now()
  const { data, error } = await sb()
    .from('visual_options')
    .insert(rows.map((r, i) => ({ ...r, id: crypto.randomUUID(), sort_order: base + i })))
    .select()
  if (error) throw error
  setState((s) => ({ options: [...s.options, ...(data as VisualOption[])] }))
}

export async function deleteOption(id: string) {
  const { error } = await sb().from('visual_options').delete().eq('id', id)
  if (error) throw error
  setState((s) => ({ options: s.options.filter((x) => x.id !== id) }))
}

// ───────────── 연결 상태 ─────────────

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    setState({ online: true })
    flushAll()
  })
  window.addEventListener('offline', () => setState({ online: false }))
  window.addEventListener('beforeunload', (ev) => {
    const p = pendingSummary(state)
    if (p.pending + p.saving > 0) {
      flushAll()
      ev.preventDefault()
    }
  })
}

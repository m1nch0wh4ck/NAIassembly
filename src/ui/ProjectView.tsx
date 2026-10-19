import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createReactions,
  deleteProject,
  deleteReactions,
  edit,
  errMsg,
  moveReaction,
  openProject,
  refreshProject,
  setStatusBulk,
  sortedReactions,
  toast,
  useStore,
  view,
  type Counts,
} from '../data/store'
import { duplicateValues, normKey, sanitizeBaseName } from '../lib/filename'
import { STATUSES, STATUS_LABEL, type Candidate, type Project, type Reaction, type Status } from '../types'
import { StatusBadge, StoredImage, TextField, ask, go, useMobile } from './common'
import { ReactionEditor } from './ReactionEditor'
import { BackupDialog, CloneDialog, CompareReactionsDialog, ExportDialog } from './Dialogs'
import { useUploads } from '../data/uploads'

export interface Dup {
  keyword: Set<string>
  filename: Set<string>
}

export const effName = (r: Reaction) => normKey(sanitizeBaseName(r.filename || r.emotion, 'png', '').name)

export function reactionThumb(r: Reaction, cands: Candidate[] | undefined): Candidate | null {
  if (!cands?.length) return null
  return cands.find((c) => c.id === r.adopted_candidate_id) ?? cands[cands.length - 1]
}

export function ProjectView({ projectId, reactionId }: { projectId: string; reactionId: string | null }) {
  const mobile = useMobile()
  const pe = useStore((s) => s.projects[projectId])
  const loaded = useStore((s) => s.projectsLoaded)
  const loading = useStore((s) => s.projectLoading)
  const reactionsMap = useStore((s) => s.reactions)
  const candidates = useStore((s) => s.candidates)
  const counts = useStore((s) => s.projectStats[projectId])
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Status | 'all'>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<'table' | 'board'>(() => (localStorage.getItem('nra:view') as 'table' | 'board') || 'table')
  const [dialog, setDialog] = useState<null | 'export' | 'backup' | 'clone' | 'compare'>(null)
  const [memoOpen, setMemoOpen] = useState(false)

  useEffect(() => {
    void openProject(projectId)
  }, [projectId])

  // 다른 기기에서 바뀐 내용 반영: 화면으로 돌아올 때 + 30초마다
  useEffect(() => {
    const tick = () => document.visibilityState === 'visible' && void refreshProject()
    const t = setInterval(tick, 30_000)
    document.addEventListener('visibilitychange', tick)
    window.addEventListener('focus', tick)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', tick)
      window.removeEventListener('focus', tick)
    }
  }, [])

  useEffect(() => localStorage.setItem('nra:view', mode), [mode])

  const all = useMemo(() => sortedReactions({ reactions: reactionsMap } as never).map(view), [reactionsMap])
  const dup: Dup = useMemo(
    () => ({ keyword: duplicateValues(all.map((r) => r.keyword)), filename: duplicateValues(all.map(effName)) }),
    [all],
  )
  const list = useMemo(() => {
    const k = q.trim().toLowerCase()
    return all.filter((r) => {
      if (filter !== 'all' && r.status !== filter) return false
      if (!k) return true
      return [r.emotion, r.keyword, r.memo, r.expression, r.tags, r.filename].some((v) => v.toLowerCase().includes(k))
    })
  }, [all, q, filter])

  if (!pe) {
    return <div className="page muted">{loaded ? '프로젝트를 찾을 수 없습니다. 삭제되었거나 다른 계정의 프로젝트입니다.' : '불러오는 중…'}</div>
  }
  const project = view(pe)
  const c: Counts = counts ?? { total: 0, todo: 0, generated: 0, rework: 0, adopted: 0 }
  const active = reactionId ? all.find((r) => r.id === reactionId) ?? null : null
  const selIds = [...selected].filter((id) => reactionsMap[id])
  const canDrag = !q.trim() && filter === 'all'

  const addReaction = async () => {
    try {
      const [r] = await createReactions(projectId, [{}], active?.id)
      go(projectId, r.id)
    } catch (e) {
      toast(`추가하지 못했습니다: ${errMsg(e)}`, 'error')
    }
  }

  const removeSelected = async () => {
    const imgs = selIds.reduce((a, id) => a + (candidates[id]?.length ?? 0), 0)
    const adopted = selIds.filter((id) => view(reactionsMap[id]).status === 'adopted').length
    const ok = await ask({
      title: `리액션 ${selIds.length}개 삭제`,
      body: (
        <>
          <p>
            선택한 리액션 {selIds.length}개와 등록된 이미지 {imgs}장(채택 {adopted}장 포함)을 삭제합니다. 되돌릴 수 없습니다.
          </p>
          <p className="muted small">필요하면 먼저 프로젝트 백업을 만들어 두세요.</p>
        </>
      ),
      ok: '삭제',
      danger: true,
      typeToConfirm: imgs > 0 ? '삭제' : undefined,
    })
    if (!ok) return
    try {
      await deleteReactions(selIds)
      setSelected(new Set())
      if (reactionId && selIds.includes(reactionId)) go(projectId, null, true)
      toast('삭제했습니다', 'ok')
    } catch (e) {
      toast(`삭제하지 못했습니다: ${errMsg(e)}`, 'error')
    }
  }

  const bulkStatus = async (st: Exclude<Status, 'adopted'>) => {
    const adopted = selIds.filter((id) => view(reactionsMap[id]).status === 'adopted').length
    if (adopted) {
      const ok = await ask({
        title: '채택 해제 확인',
        body: <p>선택 중 {adopted}개는 채택된 리액션입니다. ‘{STATUS_LABEL[st]}’(으)로 바꾸면 채택이 해제됩니다(이미지는 남습니다).</p>,
        ok: '변경',
      })
      if (!ok) return
    }
    setStatusBulk(selIds, st)
  }

  const toolbar = (
    <div className="toolbar">
      <input className="search" type="search" placeholder="감정·키워드·메모 검색" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="chips">
        <button className={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>
          전체 {c.total}
        </button>
        {STATUSES.map((st) => (
          <button key={st} className={`chip st-${st}-chip ${filter === st ? 'on' : ''}`} onClick={() => setFilter(filter === st ? 'all' : st)}>
            {STATUS_LABEL[st]} {c[st]}
          </button>
        ))}
      </div>
    </div>
  )

  // ───────── 모바일: 한 리액션 중심 ─────────
  if (mobile) {
    if (active) {
      const idx = list.findIndex((r) => r.id === active.id)
      return (
        <div className="m-focus">
          <div className="m-nav">
            <button onClick={() => go(projectId)}>← 목록</button>
            <span className="muted small">
              {idx >= 0 ? `${idx + 1}/${list.length}` : ''}
            </span>
            <div className="row">
              <button disabled={idx <= 0} onClick={() => go(projectId, list[idx - 1].id, true)} aria-label="이전 리액션">
                ‹ 이전
              </button>
              <button disabled={idx < 0 || idx >= list.length - 1} onClick={() => go(projectId, list[idx + 1].id, true)} aria-label="다음 리액션">
                다음 ›
              </button>
            </div>
          </div>
          <ReactionEditor key={active.id} reaction={active} dup={dup} mobile />
        </div>
      )
    }
    return (
      <div className="page m-list">
        <ProjectHeader project={project} memoOpen={memoOpen} setMemoOpen={setMemoOpen} compact />
        {toolbar}
        {loading && !all.length && <p className="muted">불러오는 중…</p>}
        {!loading && !all.length && <EmptyReactions onAdd={addReaction} onClone={() => setDialog('clone')} />}
        <ul className="m-rows">
          {list.map((r) => (
            <MobileRow key={r.id} r={r} cands={candidates[r.id]} dup={dup} onOpen={() => go(projectId, r.id)} />
          ))}
        </ul>
        <div className="m-actions">
          <button onClick={() => setDialog('export')}>내보내기</button>
          <button className="primary" onClick={addReaction}>
            + 리액션
          </button>
        </div>
        {dialog && <ProjectDialogs dialog={dialog} close={() => setDialog(null)} project={project} selIds={selIds} all={all} />}
      </div>
    )
  }

  // ───────── PC ─────────
  return (
    <div className="pc-project">
      <div className="pc-left">
        <ProjectHeader project={project} memoOpen={memoOpen} setMemoOpen={setMemoOpen} />
        <div className="row wrap gap">
          <button className="primary" onClick={addReaction}>
            + 리액션
          </button>
          <button onClick={() => setDialog('clone')}>다른 프로젝트에서 목록 복제</button>
          <button onClick={() => setDialog('export')}>채택 이미지 내보내기</button>
          <button onClick={() => setDialog('backup')}>백업</button>
          <div className="grow" />
          <div className="seg">
            <button className={mode === 'table' ? 'on' : ''} onClick={() => setMode('table')}>
              표
            </button>
            <button className={mode === 'board' ? 'on' : ''} onClick={() => setMode('board')}>
              보드
            </button>
          </div>
          <button className="ghost" onClick={() => void refreshProject().then(() => toast('최신 내용으로 갱신했습니다', 'ok'))}>
            새로고침
          </button>
        </div>
        {toolbar}
        {selIds.length > 0 && (
          <div className="selbar">
            <b>{selIds.length}개 선택</b>
            <span className="muted small">상태 변경:</span>
            {(['todo', 'generated', 'rework'] as const).map((st) => (
              <button key={st} onClick={() => bulkStatus(st)}>
                {STATUS_LABEL[st]}
              </button>
            ))}
            <button onClick={() => setDialog('compare')} disabled={selIds.length < 2}>
              나란히 비교
            </button>
            <button onClick={() => setDialog('export')}>선택 내보내기</button>
            <button className="danger" onClick={removeSelected}>
              삭제
            </button>
            <button className="ghost" onClick={() => setSelected(new Set())}>
              선택 해제
            </button>
          </div>
        )}
        {loading && !all.length && <p className="muted">불러오는 중…</p>}
        {!loading && !all.length && <EmptyReactions onAdd={addReaction} onClone={() => setDialog('clone')} />}
        {all.length > 0 &&
          (mode === 'table' ? (
            <ReactionTable
              list={list}
              candidates={candidates}
              dup={dup}
              activeId={reactionId}
              selected={selected}
              setSelected={setSelected}
              canDrag={canDrag}
              projectId={projectId}
            />
          ) : (
            <ReactionBoard list={list} candidates={candidates} dup={dup} activeId={reactionId} selected={selected} setSelected={setSelected} projectId={projectId} />
          ))}
        {all.length > 0 && !list.length && <p className="muted">조건에 맞는 리액션이 없습니다.</p>}
      </div>
      <aside className="pc-right">
        {active ? (
          <ReactionEditor key={active.id} reaction={active} dup={dup} />
        ) : (
          <div className="muted pad">왼쪽 목록에서 리액션을 선택하면 여기서 편집·이미지 등록·채택을 할 수 있습니다.</div>
        )}
      </aside>
      {dialog && <ProjectDialogs dialog={dialog} close={() => setDialog(null)} project={project} selIds={selIds} all={all} />}
    </div>
  )
}

function ProjectDialogs(p: {
  dialog: 'export' | 'backup' | 'clone' | 'compare'
  close: () => void
  project: Project
  selIds: string[]
  all: Reaction[]
}) {
  const target = p.selIds.length ? p.all.filter((r) => p.selIds.includes(r.id)) : p.all
  if (p.dialog === 'export') return <ExportDialog project={p.project} reactions={target} scope={p.selIds.length ? 'selected' : 'all'} onClose={p.close} />
  if (p.dialog === 'backup') return <BackupDialog project={p.project} onClose={p.close} />
  if (p.dialog === 'clone') return <CloneDialog project={p.project} onClose={p.close} />
  return <CompareReactionsDialog reactions={target} onClose={p.close} />
}

function ProjectHeader(p: { project: Project; memoOpen: boolean; setMemoOpen: (v: boolean) => void; compact?: boolean }) {
  const { project } = p
  const set = (patch: Partial<Project>) => edit<Project>('projects', project.id, patch)
  const del = async () => {
    const ok = await ask({
      title: '프로젝트 삭제',
      body: <p>“{project.name}” 프로젝트와 모든 리액션·이미지를 삭제합니다. 되돌릴 수 없습니다. 필요하면 먼저 백업을 만드세요.</p>,
      ok: '프로젝트 삭제',
      danger: true,
      typeToConfirm: project.name || '삭제',
    })
    if (!ok) return
    try {
      await deleteProject(project.id)
      go(null)
      toast('프로젝트를 삭제했습니다', 'ok')
    } catch (e) {
      toast(`삭제하지 못했습니다: ${errMsg(e)}`, 'error')
    }
  }
  return (
    <div className={`proj-head ${p.compact ? 'compact' : ''}`}>
      <div className="row wrap gap">
        <TextField className="title-field" value={project.name} onChange={(v) => set({ name: v })} placeholder="프로젝트명" maxLength={200} />
        <TextField className="char-field" value={project.character_name} onChange={(v) => set({ character_name: v })} placeholder="캐릭터명" maxLength={200} />
        <button className="ghost small" onClick={() => p.setMemoOpen(!p.memoOpen)}>
          {p.memoOpen ? '메모 닫기' : project.memo ? '메모 ●' : '메모'}
        </button>
        <button className="ghost small danger-text" onClick={del}>
          프로젝트 삭제
        </button>
      </div>
      {p.memoOpen && <TextField multiline rows={3} value={project.memo} onChange={(v) => set({ memo: v })} placeholder="프로젝트 메모" />}
    </div>
  )
}

function EmptyReactions({ onAdd, onClone }: { onAdd: () => void; onClone: () => void }) {
  return (
    <div className="card guide">
      <h2>리액션이 아직 없습니다</h2>
      <p>필요한 리액션을 하나씩 추가하거나, 다른 프로젝트의 목록을 복제해 시작하세요.</p>
      <div className="row gap">
        <button className="primary" onClick={onAdd}>
          + 리액션 추가
        </button>
        <button onClick={onClone}>다른 프로젝트에서 목록 복제</button>
      </div>
    </div>
  )
}

export function Warnings({ r, dup }: { r: Reaction; dup: Dup }) {
  const kw = r.keyword.trim() && dup.keyword.has(normKey(r.keyword))
  const fn = dup.filename.has(effName(r))
  if (!kw && !fn) return null
  return (
    <span className="warns">
      {kw && <span className="warn-tag" title="같은 호출 키워드가 다른 리액션에도 있습니다">키워드 중복</span>}
      {fn && <span className="warn-tag" title="내보낼 파일명이 다른 리액션과 같습니다">파일명 중복</span>}
    </span>
  )
}

function UploadDot({ reactionId }: { reactionId: string }) {
  const ups = useUploads().filter((u) => u.reactionId === reactionId && u.state !== 'done')
  if (!ups.length) return null
  const failed = ups.some((u) => u.state === 'failed')
  return <span className={`up-dot ${failed ? 'bad' : ''}`} title={failed ? '업로드 실패 있음' : '업로드 중'} />
}

function ReactionTable(p: {
  list: Reaction[]
  candidates: Record<string, Candidate[]>
  dup: Dup
  activeId: string | null
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  canDrag: boolean
  projectId: string
}) {
  const dragId = useRef<string | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const allSel = p.list.length > 0 && p.list.every((r) => p.selected.has(r.id))
  const toggle = (id: string) => {
    const n = new Set(p.selected)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    p.setSelected(n)
  }
  return (
    <div className="table-wrap">
      <table className="rtable">
        <thead>
          <tr>
            <th className="c-sel">
              <input
                type="checkbox"
                checked={allSel}
                aria-label="전체 선택"
                onChange={() => p.setSelected(allSel ? new Set() : new Set(p.list.map((r) => r.id)))}
              />
            </th>
            <th className="c-th">이미지</th>
            <th>감정·상태 / 표현 설명</th>
            <th>호출 키워드 · 파일명</th>
            <th className="c-st">상태</th>
            <th className="c-n">후보</th>
          </tr>
        </thead>
        <tbody>
          {p.list.map((r, i) => {
            const cands = p.candidates[r.id]
            const th = reactionThumb(r, cands)
            return (
              <tr
                key={r.id}
                className={`${p.activeId === r.id ? 'active' : ''} ${over === i ? 'drop' : ''}`}
                onClick={() => go(p.projectId, r.id, !!p.activeId)}
                draggable={p.canDrag}
                onDragStart={(e) => {
                  dragId.current = r.id
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/x-reaction', r.id)
                }}
                onDragOver={(e) => {
                  if (!dragId.current) return
                  e.preventDefault()
                  setOver(i)
                }}
                onDragLeave={() => setOver(null)}
                onDrop={(e) => {
                  e.preventDefault()
                  setOver(null)
                  const id = dragId.current
                  dragId.current = null
                  if (!id || id === r.id) return
                  // 끌어 온 항목을 뺀 목록 기준으로 이 행의 자리(i)에 놓습니다.
                  moveReaction(id, i)
                }}
                onDragEnd={() => {
                  dragId.current = null
                  setOver(null)
                }}
              >
                <td className="c-sel" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={p.selected.has(r.id)} onChange={() => toggle(r.id)} aria-label="선택" />
                </td>
                <td className="c-th">
                  {th ? <StoredImage path={th.thumb_path} fallbackPath={th.storage_path} alt="" className="thumb-s" /> : <div className="thumb-s empty" />}
                </td>
                <td>
                  <div className="r-emotion">
                    {p.canDrag && <span className="grip" title="끌어서 순서 변경">⋮⋮</span>}
                    {r.emotion || <span className="muted">(감정명 없음)</span>}
                    <UploadDot reactionId={r.id} />
                  </div>
                  <div className="r-expr muted small">{r.expression || '—'}</div>
                </td>
                <td>
                  <div className="small">{r.keyword ? <code>{r.keyword}</code> : <span className="muted">키워드 없음</span>}</div>
                  <div className="small muted">{r.filename || (r.emotion ? `(${r.emotion})` : '')}</div>
                  <Warnings r={r} dup={p.dup} />
                </td>
                <td className="c-st">
                  <StatusBadge status={r.status} />
                </td>
                <td className="c-n">{cands?.length ?? 0}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {!p.canDrag && <p className="muted small">검색·필터 중에는 끌어서 순서를 바꿀 수 없습니다.</p>}
    </div>
  )
}

function ReactionBoard(p: {
  list: Reaction[]
  candidates: Record<string, Candidate[]>
  dup: Dup
  activeId: string | null
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  projectId: string
}) {
  return (
    <div className="board">
      {p.list.map((r) => {
        const cands = p.candidates[r.id]
        const th = reactionThumb(r, cands)
        return (
          <div key={r.id} className={`bcard ${p.activeId === r.id ? 'active' : ''}`} onClick={() => go(p.projectId, r.id, !!p.activeId)}>
            <label className="bsel" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={p.selected.has(r.id)}
                onChange={() => {
                  const n = new Set(p.selected)
                  if (n.has(r.id)) n.delete(r.id)
                  else n.add(r.id)
                  p.setSelected(n)
                }}
              />
            </label>
            {th ? <StoredImage path={th.thumb_path} fallbackPath={th.storage_path} alt={r.emotion} className="thumb-b" /> : <div className="thumb-b empty">이미지 없음</div>}
            <div className="bmeta">
              <div className="row between">
                <b>{r.emotion || '(감정명 없음)'}</b>
                <StatusBadge status={r.status} />
              </div>
              <div className="small muted clamp2">{r.expression}</div>
              <div className="small">
                {r.keyword && <code>{r.keyword}</code>} <span className="muted">후보 {cands?.length ?? 0}</span>
                <UploadDot reactionId={r.id} />
              </div>
              <Warnings r={r} dup={p.dup} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function MobileRow({ r, cands, dup, onOpen }: { r: Reaction; cands?: Candidate[]; dup: Dup; onOpen: () => void }) {
  const th = reactionThumb(r, cands)
  return (
    <li>
      <button className="m-row" onClick={onOpen}>
        {th ? <StoredImage path={th.thumb_path} fallbackPath={th.storage_path} alt="" className="thumb-m" /> : <div className="thumb-m empty" />}
        <div className="m-row-main">
          <div className="row between">
            <b>{r.emotion || '(감정명 없음)'}</b>
            <StatusBadge status={r.status} />
          </div>
          <div className="small muted clamp1">{r.expression || '—'}</div>
          <div className="small">
            {r.keyword && <code>{r.keyword}</code>} <span className="muted">후보 {cands?.length ?? 0}</span>
            <UploadDot reactionId={r.id} />
          </div>
          <Warnings r={r} dup={dup} />
        </div>
      </button>
    </li>
  )
}

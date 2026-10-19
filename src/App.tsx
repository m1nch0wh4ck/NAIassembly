import { useEffect, useMemo, useState } from 'react'
import type { AppConfig } from './config'
import { clearDeviceConfig } from './config'
import {
  discardLocal,
  flushAll,
  pendingSummary,
  resolveConflict,
  signIn,
  signOut,
  useStore,
  view,
  type Entity,
  type State,
  type Table,
} from './data/store'
import { restoreUploads, retry, uploadSummary, useUploads } from './data/uploads'
import { ConfirmHost, Modal, go, useRoute } from './ui/common'
import { Home } from './ui/Home'
import { ProjectView } from './ui/ProjectView'
import { SettingsDialog } from './ui/Settings'
import { FIELD_LABEL, STATUS_LABEL, type Reaction, type Status, type VisualItem } from './types'

export function App({ config }: { config: AppConfig }) {
  const authReady = useStore((s) => s.authReady)
  const session = useStore((s) => s.session)
  useEffect(() => {
    if (session) void restoreUploads(session.user.id)
  }, [session?.user.id])
  if (!authReady) return <div className="center-page muted">불러오는 중…</div>
  if (!session) return <Login config={config} />
  return <Shell config={config} />
}

function Login({ config }: { config: AppConfig }) {
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="center-page">
      <form
        className="card login"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setErr('')
          try {
            await signIn(email, pw)
          } catch (ex) {
            const m = (ex as Error).message
            setErr(/Invalid login/i.test(m) ? '이메일 또는 비밀번호가 맞지 않습니다' : m)
          } finally {
            setBusy(false)
          }
        }}
      >
        <h1>리액션 작업실</h1>
        <p className="muted">NovelAI 리액션 에셋 제작 관리 · 개인용</p>
        <label className="field">
          <span>이메일</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </label>
        <label className="field">
          <span>비밀번호</span>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" required />
        </label>
        {err && <p className="error">{err}</p>}
        <button className="primary" disabled={busy} type="submit">
          {busy ? '로그인 중…' : '로그인'}
        </button>
        <p className="muted small">
          계정은 Supabase 대시보드에서 소유자 한 명만 만듭니다(README 3단계). 이 화면에는 가입 기능이 없습니다.
        </p>
        {config.source === 'device' && (
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              clearDeviceConfig()
              location.reload()
            }}
          >
            이 기기의 접속 설정 지우기
          </button>
        )}
      </form>
    </div>
  )
}

function Shell({ config }: { config: AppConfig }) {
  const route = useRoute()
  const [settings, setSettings] = useState(false)
  const projects = useStore((s) => s.projects)
  const title = route.project && projects[route.project] ? view(projects[route.project]).name || '(이름 없음)' : null
  return (
    <div className="app">
      <header className="topbar">
        <button className="ghost brand" onClick={() => go(null)}>
          리액션 작업실
        </button>
        {title && <span className="crumb">/ {title}</span>}
        <div className="grow" />
        <SyncIndicator />
        <button className="ghost" onClick={() => setSettings(true)} aria-label="설정">
          설정
        </button>
      </header>
      <main>{route.project ? <ProjectView key={route.project} projectId={route.project} reactionId={route.reaction} /> : <Home />}</main>
      {settings && <SettingsDialog config={config} onClose={() => setSettings(false)} onSignOut={signOut} />}
      <ConflictHost />
      <Toasts />
      <ConfirmHost />
    </div>
  )
}

function SyncIndicator() {
  const projects = useStore((s) => s.projects)
  const reactions = useStore((s) => s.reactions)
  const sum = useMemo(() => pendingSummary({ projects, reactions } as State), [projects, reactions])
  const online = useStore((s) => s.online)
  const syncError = useStore((s) => s.syncError)
  const uploads = useUploads()
  const up = uploadSummary(uploads)
  const [open, setOpen] = useState(false)
  let cls = 'ok'
  let text = '저장됨'
  if (!online) {
    cls = 'bad'
    text = '오프라인 · 이 기기에 임시 보관 중'
  } else if (sum.conflicts) {
    cls = 'bad'
    text = `충돌 ${sum.conflicts}건 확인 필요`
  } else if (sum.failed || up.failed) {
    cls = 'bad'
    text = `저장 실패 ${sum.failed + up.failed}건`
  } else if (sum.saving || sum.pending || up.active) {
    cls = 'busy'
    text = [sum.saving + sum.pending ? `저장 중 ${sum.saving + sum.pending}` : '', up.active ? `업로드 ${up.active}` : ''].filter(Boolean).join(' · ')
  } else if (syncError) {
    cls = 'warn'
    text = '서버 연결 확인 필요'
  }
  return (
    <div className="sync-wrap">
      <button className={`sync ${cls}`} onClick={() => setOpen(!open)} aria-live="polite" title="저장·동기화 상태">
        <i />
        {text}
      </button>
      {open && (
        <div className="popover" onMouseLeave={() => setOpen(false)}>
          <p>
            <b>저장 상태</b>
          </p>
          <ul className="plain small">
            <li>네트워크: {online ? '연결됨' : '끊김'}</li>
            <li>저장 대기·진행: {sum.pending + sum.saving}건</li>
            <li>저장 실패: {sum.failed}건</li>
            <li>충돌: {sum.conflicts}건</li>
            <li>이미지 업로드 진행: {up.active}건 · 실패 {up.failed}건</li>
            {syncError && <li className="error">마지막 오류: {syncError}</li>}
          </ul>
          <p className="muted small">편집 내용은 서버에 저장될 때까지 이 기기에 임시 보관됩니다. 업로드는 서버 기록까지 끝나야 완료로 표시됩니다.</p>
          <div className="row">
            <button
              onClick={() => {
                flushAll()
                for (const u of uploads) if (u.state === 'failed' && !u.fatal) retry(u.id)
              }}
            >
              실패 항목 다시 시도
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  )
}

function fmtValue(field: string, v: unknown, cands?: Record<string, string>): string {
  if (v === null || v === undefined || v === '') return '(비어 있음)'
  if (field === 'status') return STATUS_LABEL[v as Status] ?? String(v)
  if (field === 'visual') return (v as VisualItem[]).map((x) => `${x.label || '?'}(${x.tag || '-'})`).join(', ') || '(없음)'
  if (field === 'adopted_candidate_id') return cands?.[String(v)] ?? '선택된 이미지'
  if (field === 'sort_order') return '목록 순서'
  return String(v)
}

/** 다른 기기와 같은 항목을 동시에 고친 경우: 필드별로 어느 값을 쓸지 고릅니다. */
function ConflictHost() {
  const projects = useStore((s) => s.projects)
  const reactions = useStore((s) => s.reactions)
  const candidates = useStore((s) => s.candidates)
  const items: { table: Table; id: string; e: Entity<unknown> }[] = [
    ...Object.entries(projects).map(([id, e]) => ({ table: 'projects' as Table, id, e: e as Entity<unknown> })),
    ...Object.entries(reactions).map(([id, e]) => ({ table: 'reactions' as Table, id, e: e as Entity<unknown> })),
  ].filter((x) => x.e.conflict || (x.e.deleted && Object.keys(x.e.local as object).length))
  const [choice, setChoice] = useState<Record<string, 'mine' | 'server'>>({})
  const cur = items[0]
  useEffect(() => setChoice({}), [cur?.id])
  if (!cur) return null
  const base = cur.e.base as Record<string, unknown>
  const local = cur.e.local as Record<string, unknown>
  const name = cur.table === 'projects' ? `프로젝트 "${base.name || '(이름 없음)'}"` : `리액션 "${(base as unknown as Reaction).emotion || '(이름 없음)'}"`
  const candNames: Record<string, string> = {}
  if (cur.table === 'reactions') for (const c of candidates[cur.id] ?? []) candNames[c.id] = `이미지: ${c.original_name}`
  if (cur.e.deleted) {
    return (
      <Modal title="다른 기기에서 삭제된 항목" onClose={() => discardLocal(cur.table, cur.id)}
        footer={<button className="primary" onClick={() => discardLocal(cur.table, cur.id)}>확인(내 수정 버리기)</button>}>
        <p>{name}은(는) 다른 기기에서 삭제되어 이 기기의 수정 내용을 저장할 수 없습니다.</p>
        <ul className="small">
          {Object.entries(local).map(([f, v]) => (
            <li key={f}>
              {FIELD_LABEL[f] ?? f}: {fmtValue(f, v, candNames)}
            </li>
          ))}
        </ul>
        <p className="muted small">필요한 내용은 위에서 복사해 두세요.</p>
      </Modal>
    )
  }
  const fields = (cur.e.conflict ?? []).filter((f) => f !== 'tags_auto')
  return (
    <Modal
      title="수정 충돌 확인"
      wide
      onClose={() => undefined}
      footer={
        <>
          <button onClick={() => resolveConflict(cur.table, cur.id, Object.fromEntries(fields.map((f) => [f, 'server'])))}>모두 다른 기기 값</button>
          <button onClick={() => resolveConflict(cur.table, cur.id, Object.fromEntries(fields.map((f) => [f, 'mine'])))}>모두 내 값</button>
          <button
            className="primary"
            disabled={fields.some((f) => !choice[f])}
            onClick={() => {
              const c = { ...choice }
              if (c.tags) c.tags_auto = c.tags
              resolveConflict(cur.table, cur.id, c)
            }}
          >
            선택대로 적용
          </button>
        </>
      }
    >
      <p>
        {name} — {cur.e.conflictReason ?? '다른 기기에서 먼저 수정했습니다.'} 덮어쓰지 않도록 저장을 멈췄습니다. 항목별로 남길 값을 고르세요.
      </p>
      <table className="conflict">
        <thead>
          <tr>
            <th>항목</th>
            <th>이 기기(내 수정)</th>
            <th>서버(다른 기기)</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f}>
              <td>{FIELD_LABEL[f] ?? f}</td>
              <td>
                <label className="pick">
                  <input type="radio" name={f} checked={choice[f] === 'mine'} onChange={() => setChoice({ ...choice, [f]: 'mine' })} />
                  <span className="pre">{fmtValue(f, local[f], candNames)}</span>
                </label>
              </td>
              <td>
                <label className="pick">
                  <input type="radio" name={f} checked={choice[f] === 'server'} onChange={() => setChoice({ ...choice, [f]: 'server' })} />
                  <span className="pre">{fmtValue(f, base[f], candNames)}</span>
                </label>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length > 1 && <p className="muted small">확인할 충돌이 {items.length - 1}건 더 있습니다.</p>}
    </Modal>
  )
}

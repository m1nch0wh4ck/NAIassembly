import { useEffect, useMemo, useState } from 'react'
import { createProject, errMsg, loadProjects, toast, useStore, view } from '../data/store'
import { cloneReactions, fetchProjectReactions, parseBackup, restoreBackup, type ParsedBackup } from '../data/transfer'
import { isBackupError } from '../lib/backup'
import { formatBytes } from '../lib/format'
import { Modal, Progress, fmtDate, go } from './common'

export function Home() {
  const projects = useStore((s) => s.projects)
  const stats = useStore((s) => s.projectStats)
  const loaded = useStore((s) => s.projectsLoaded)
  const [creating, setCreating] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const list = useMemo(
    () => Object.values(projects).map(view).sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [projects],
  )
  useEffect(() => {
    const h = () => document.visibilityState === 'visible' && void loadProjects()
    document.addEventListener('visibilitychange', h)
    return () => document.removeEventListener('visibilitychange', h)
  }, [])
  return (
    <div className="page home">
      <div className="page-head">
        <h1>캐릭터 프로젝트</h1>
        <div className="row">
          <button onClick={() => setRestoring(true)}>백업에서 복원</button>
          <button className="primary" onClick={() => setCreating(true)}>
            + 새 프로젝트
          </button>
        </div>
      </div>
      {!loaded && <p className="muted">불러오는 중…</p>}
      {loaded && list.length === 0 && <Guide onCreate={() => setCreating(true)} />}
      <div className="project-grid">
        {list.map((p) => {
          const c = stats[p.id] ?? { total: 0, todo: 0, generated: 0, rework: 0, adopted: 0 }
          const pct = c.total ? Math.round((c.adopted / c.total) * 100) : 0
          return (
            <button key={p.id} className="card project-card" onClick={() => go(p.id)}>
              <div className="pc-title">{p.name || '(이름 없음)'}</div>
              <div className="muted">{p.character_name || '캐릭터 미입력'}</div>
              <div className="pc-bar">
                <div style={{ width: `${pct}%` }} />
              </div>
              <div className="pc-stats small">
                <span>전체 {c.total}</span>
                <span className="st-todo-t">미작업 {c.todo}</span>
                <span className="st-rework-t">재작업 {c.rework}</span>
                <span className="st-adopted-t">채택 {c.adopted}</span>
              </div>
              <div className="muted small">수정 {fmtDate(p.updated_at)}</div>
            </button>
          )
        })}
      </div>
      {list.length > 0 && (
        <details className="guide-fold">
          <summary>사용 안내</summary>
          <GuideSteps />
        </details>
      )}
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
      {restoring && <RestoreDialog onClose={() => setRestoring(false)} />}
    </div>
  )
}

function Guide({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="card guide">
      <h2>처음 오셨네요</h2>
      <p>아직 프로젝트가 없습니다. 캐릭터별로 프로젝트를 만들고 필요한 리액션을 채워 나가세요.</p>
      <GuideSteps />
      <button className="primary" onClick={onCreate}>
        첫 프로젝트 만들기
      </button>
    </div>
  )
}

function GuideSteps() {
  return (
    <ol className="steps">
      <li>
        <b>프로젝트 만들기</b> — 캐릭터 하나당 하나. 다른 프로젝트의 리액션 목록을 복제해 시작할 수도 있습니다(이미지·진행 상태는 기본 제외).
      </li>
      <li>
        <b>리액션 설계</b> — 감정·상태명, 이 캐릭터다운 표현 설명, 시각 요소(눈·입·시선·자세·손·부가 표현), 태그, 호출 키워드, 파일명을 각각
        입력합니다. 시각 요소는 <i>설정 → 선택 항목</i>에 저장해 두고 골라 쓸 수 있습니다.
      </li>
      <li>
        <b>태그 복사 → NAI에서 생성</b> — 복사 전 최종 태그를 확인·수정할 수 있습니다. 이 앱은 NovelAI에 접속하지 않습니다.
      </li>
      <li>
        <b>이미지 등록</b> — PC는 끌어 놓기/파일 선택, 모바일은 이미지 선택. 원본 파일을 그대로 보관합니다(메타데이터 유지).
      </li>
      <li>
        <b>비교·채택</b> — 후보를 확대·비교하고 한 장을 채택합니다. 마음에 안 들면 ‘재작업’으로 표시합니다.
      </li>
      <li>
        <b>내보내기</b> — 채택 이미지만 지정한 파일명으로 ZIP에 담습니다. 프로젝트 백업(설계+이미지)도 따로 만들 수 있습니다.
      </li>
    </ol>
  )
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const projects = useStore((s) => s.projects)
  const [name, setName] = useState('')
  const [character, setCharacter] = useState('')
  const [memo, setMemo] = useState('')
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const others = Object.values(projects).map(view)
  const submit = async () => {
    if (!name.trim() && !character.trim()) return toast('프로젝트명이나 캐릭터명을 입력하세요', 'error')
    setBusy(true)
    try {
      const id = await createProject(name || character, character, memo)
      if (source) {
        const src = await fetchProjectReactions(source)
        const r = await cloneReactions(src, src.reactions.map((x) => x.id), id, { includeMemo: true, includeImages: false }, () => undefined)
        toast(`리액션 ${r.created}개를 복제했습니다`, 'ok')
      }
      onClose()
      go(id)
    } catch (e) {
      toast(`만들지 못했습니다: ${errMsg(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title="새 프로젝트"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>취소</button>
          <button className="primary" disabled={busy} onClick={submit}>
            {busy ? '만드는 중…' : '만들기'}
          </button>
        </>
      }
    >
      <label className="field">
        <span>프로젝트명</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 하루 리액션 1차" autoFocus />
      </label>
      <label className="field">
        <span>캐릭터명</span>
        <input value={character} onChange={(e) => setCharacter(e.target.value)} placeholder="예: 하루" />
      </label>
      <label className="field">
        <span>메모</span>
        <textarea rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} />
      </label>
      {others.length > 0 && (
        <label className="field">
          <span>리액션 목록 복제(선택)</span>
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">빈 목록으로 시작</option>
            {others.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} {p.character_name ? `· ${p.character_name}` : ''}
              </option>
            ))}
          </select>
          <small className="hint">설계 정보만 새 ID로 복사합니다. 이미지와 진행 상태는 포함하지 않으며, 원본 프로젝트와 독립적으로 수정됩니다.</small>
        </label>
      )}
    </Modal>
  )
}

function RestoreDialog({ onClose }: { onClose: () => void }) {
  const [parsed, setParsed] = useState<ParsedBackup | null>(null)
  const [err, setErr] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [prog, setProg] = useState<{ done: number; total: number; label: string } | null>(null)
  const pick = async (f: File | undefined) => {
    setErr('')
    setParsed(null)
    if (!f) return
    setBusy(true)
    try {
      const p = await parseBackup(new Uint8Array(await f.arrayBuffer()))
      setParsed(p)
      setName(`${p.manifest.project.name || '복원'} (복원 ${new Date().toLocaleDateString('ko-KR')})`)
    } catch (e) {
      setErr(isBackupError(e) ? (e as Error).message : `백업을 읽지 못했습니다: ${errMsg(e)}`)
    } finally {
      setBusy(false)
    }
  }
  const run = async () => {
    if (!parsed) return
    setBusy(true)
    try {
      const id = await restoreBackup(parsed, name.trim() || '복원한 프로젝트', (done, total, label) => setProg({ done, total, label }))
      toast('복원했습니다', 'ok')
      onClose()
      go(id)
    } catch (e) {
      setErr(`복원 중 오류가 나서 만들던 프로젝트를 지웠습니다. 기존 프로젝트는 변경되지 않았습니다. (${errMsg(e)})`)
      setProg(null)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title="백업에서 복원"
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <button disabled={busy} onClick={onClose}>
            닫기
          </button>
          <button className="primary" disabled={!parsed || busy} onClick={run}>
            새 프로젝트로 복원
          </button>
        </>
      }
    >
      <p className="muted small">
        이 앱에서 만든 백업 ZIP을 선택하세요. 파일 전체를 먼저 검사하고, 이상이 없을 때만 <b>새 프로젝트</b>로 복원합니다. 기존 프로젝트는 덮어쓰지
        않습니다.
      </p>
      <input type="file" accept=".zip,application/zip" disabled={busy} onChange={(e) => pick(e.target.files?.[0])} />
      {err && <p className="error">{err}</p>}
      {parsed && (
        <div className="card soft">
          <p>
            <b>{parsed.manifest.project.name || '(이름 없음)'}</b> · {parsed.manifest.project.character_name}
          </p>
          <p className="small">
            리액션 {parsed.manifest.reactions.length}개 · 이미지 {parsed.imageCount}장 ({formatBytes(parsed.totalBytes)}) · 형식 v
            {parsed.manifest.formatVersion} · 백업 시각 {parsed.manifest.exportedAt ? fmtDate(parsed.manifest.exportedAt) : '-'}
          </p>
          {parsed.warnings.length > 0 && (
            <ul className="small warn-list">
              {parsed.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          <label className="field">
            <span>복원할 프로젝트 이름</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
      )}
      {prog && <Progress {...prog} />}
    </Modal>
  )
}

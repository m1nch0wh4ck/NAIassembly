import { useEffect, useMemo, useState } from 'react'
import { errMsg, toast, useStore, view } from '../data/store'
import { buildBackup, cloneReactions, exportZip, fetchProjectReactions, planExport, type ExportRow } from '../data/transfer'
import { downloadBlob, stamp } from '../lib/download'
import { sanitizeBaseName } from '../lib/filename'
import { formatBytes } from '../lib/format'
import type { Candidate, Project, Reaction } from '../types'
import { Modal, Progress, StatusBadge, StoredImage } from './common'
import { reactionThumb } from './ProjectView'

type Prog = { done: number; total: number; label: string } | null

const zipName = (p: Project, kind: string) => `${sanitizeBaseName(p.name || p.character_name, 'zip', 'project').name}_${kind}_${stamp()}.zip`

export function ExportDialog({ project, reactions, scope, onClose }: { project: Project; reactions: Reaction[]; scope: 'all' | 'selected'; onClose: () => void }) {
  const candidates = useStore((s) => s.candidates)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [prog, setProg] = useState<Prog>(null)
  const [err, setErr] = useState('')
  const included = reactions.filter((r) => !excluded.has(r.id))
  const rows: ExportRow[] = useMemo(() => planExport(included, candidates), [included, candidates])
  const ready = rows.filter((x) => x.plan)
  const missing = rows.filter((x) => !x.plan)
  const dupCount = ready.filter((x) => x.plan!.duplicateOf).length
  const changed = ready.filter((x) => x.plan!.notes.length).length
  const totalBytes = ready.reduce((a, x) => a + (x.candidate?.byte_size ?? 0), 0)
  const run = async () => {
    setBusy(true)
    setErr('')
    try {
      const blob = await exportZip(ready, (done, total, label) => setProg({ done, total, label }))
      downloadBlob(blob, zipName(project, '채택'))
      toast(`${ready.length}개 파일을 내보냈습니다`, 'ok')
      onClose()
    } catch (e) {
      setErr(`내보내기 실패: ${errMsg(e)}`)
    } finally {
      setBusy(false)
      setProg(null)
    }
  }
  return (
    <Modal
      title={`채택 이미지 내보내기 (${scope === 'selected' ? '선택한 리액션' : '전체'})`}
      wide
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>
            닫기
          </button>
          <button className="primary" onClick={run} disabled={busy || !ready.length}>
            ZIP 내보내기 ({ready.length}개 · {formatBytes(totalBytes)})
          </button>
        </>
      }
    >
      <p className="small muted">
        채택 이미지 원본을 재인코딩 없이 담습니다(메타데이터 유지). 확장자는 파일 실제 형식을 따릅니다. 내보내기 직전에 등록 당시 SHA-256과 대조해 다르면
        중단합니다.
      </p>
      {(dupCount > 0 || changed > 0) && (
        <p className="notice small">
          {dupCount > 0 && <>파일명이 겹치는 {dupCount}개는 덮어쓰지 않도록 번호를 붙였습니다. </>}
          {changed > 0 && <>{changed}개는 금지 문자 등으로 이름을 조정했습니다. 아래 미리보기를 확인하세요.</>}
        </p>
      )}
      <div className="table-wrap">
        <table className="ptable">
          <thead>
            <tr>
              <th>포함</th>
              <th>이미지</th>
              <th>리액션</th>
              <th>내보낼 파일명</th>
              <th>원본 파일명</th>
            </tr>
          </thead>
          <tbody>
            {reactions.map((r) => {
              const row = rows.find((x) => x.reaction.id === r.id)
              const on = !excluded.has(r.id)
              return (
                <tr key={r.id} className={!on ? 'dim' : ''}>
                  <td>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => {
                        const n = new Set(excluded)
                        if (n.has(r.id)) n.delete(r.id)
                        else n.add(r.id)
                        setExcluded(n)
                      }}
                    />
                  </td>
                  <td>{row?.candidate && <StoredImage path={row.candidate.thumb_path} fallbackPath={row.candidate.storage_path} alt="" className="thumb-s" />}</td>
                  <td>
                    {r.emotion || '(감정명 없음)'} <StatusBadge status={r.status} />
                  </td>
                  <td>
                    {!on ? (
                      <span className="muted">제외</span>
                    ) : row?.plan ? (
                      <>
                        <code className={row.plan.duplicateOf ? 'warn-text' : ''}>{row.plan.fileName}</code>
                        {row.plan.notes.map((n, i) => (
                          <div key={i} className="small warn-text">
                            {n}
                          </div>
                        ))}
                      </>
                    ) : (
                      <span className="muted">채택 이미지 없음 — 제외</span>
                    )}
                  </td>
                  <td className="small muted">{row?.candidate?.original_name ?? ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {missing.length > 0 && <p className="small muted">채택 이미지가 없는 {missing.length}개는 자동으로 제외됩니다.</p>}
      {prog && <Progress {...prog} />}
      {err && <p className="error">{err}</p>}
    </Modal>
  )
}

export function BackupDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const candidates = useStore((s) => s.candidates)
  const [busy, setBusy] = useState(false)
  const [prog, setProg] = useState<Prog>(null)
  const [err, setErr] = useState('')
  const all = Object.values(candidates).flat()
  const bytes = all.reduce((a, c) => a + c.byte_size, 0)
  const run = async () => {
    setBusy(true)
    setErr('')
    try {
      const blob = await buildBackup(project.id, (done, total, label) => setProg({ done, total, label }))
      downloadBlob(blob, zipName(project, '백업'))
      toast('백업 파일을 만들었습니다', 'ok')
      onClose()
    } catch (e) {
      setErr(`백업 실패: ${errMsg(e)}`)
    } finally {
      setBusy(false)
      setProg(null)
    }
  }
  return (
    <Modal
      title="프로젝트 백업"
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>
            닫기
          </button>
          <button className="primary" onClick={run} disabled={busy}>
            백업 ZIP 만들기
          </button>
        </>
      }
    >
      <p>
        설계 데이터(리액션·태그·메모·상태·채택)와 후보 이미지 원본 {all.length}장(약 {formatBytes(bytes)})을 한 ZIP에 담습니다.
      </p>
      <p className="small muted">
        백업 형식에는 버전 번호가 있으며, 복원은 홈 화면의 ‘백업에서 복원’에서 항상 새 프로젝트로 합니다. 다른 Supabase 프로젝트·다른 계정에서도 복원할 수
        있습니다. 이미지가 많으면 시간이 걸리고 브라우저 메모리를 많이 씁니다.
      </p>
      {prog && <Progress {...prog} />}
      {err && <p className="error">{err}</p>}
    </Modal>
  )
}

export function CloneDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const projects = useStore((s) => s.projects)
  const others = Object.values(projects)
    .map(view)
    .filter((p) => p.id !== project.id)
  const [src, setSrc] = useState(others[0]?.id ?? '')
  const [data, setData] = useState<{ reactions: Reaction[]; candidates: Candidate[] } | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [memo, setMemo] = useState(true)
  const [images, setImages] = useState(false)
  const [busy, setBusy] = useState(false)
  const [prog, setProg] = useState<Prog>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    setData(null)
    setErr('')
    if (!src) return
    let alive = true
    fetchProjectReactions(src)
      .then((d) => {
        if (!alive) return
        setData(d)
        setChosen(new Set(d.reactions.map((r) => r.id)))
      })
      .catch((e) => setErr(errMsg(e)))
    return () => {
      alive = false
    }
  }, [src])
  const run = async () => {
    if (!data) return
    setBusy(true)
    try {
      const r = await cloneReactions(data, [...chosen], project.id, { includeMemo: memo, includeImages: images }, (done, total, label) =>
        setProg({ done, total, label }),
      )
      if (r.imageErrors.length) setErr(`리액션 ${r.created}개는 복제했지만 이미지 ${r.imageErrors.length}장은 실패했습니다:\n${r.imageErrors.join('\n')}`)
      else {
        toast(`리액션 ${r.created}개를 복제했습니다`, 'ok')
        onClose()
      }
    } catch (e) {
      setErr(`복제 실패: ${errMsg(e)}`)
    } finally {
      setBusy(false)
      setProg(null)
    }
  }
  if (!others.length)
    return (
      <Modal title="다른 프로젝트에서 목록 복제" onClose={onClose}>
        <p className="muted">복제할 다른 프로젝트가 없습니다.</p>
      </Modal>
    )
  return (
    <Modal
      title="다른 프로젝트에서 목록 복제"
      wide
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>
            닫기
          </button>
          <button className="primary" onClick={run} disabled={busy || !chosen.size}>
            {chosen.size}개 복제해서 이 프로젝트 끝에 추가
          </button>
        </>
      }
    >
      <label className="field">
        <span>가져올 프로젝트</span>
        <select value={src} onChange={(e) => setSrc(e.target.value)}>
          {others.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} {p.character_name ? `· ${p.character_name}` : ''}
            </option>
          ))}
        </select>
      </label>
      <div className="row gap wrap">
        <label className="check">
          <input type="checkbox" checked={memo} onChange={(e) => setMemo(e.target.checked)} /> 작업 메모 포함
        </label>
        <label className="check">
          <input type="checkbox" checked={images} onChange={(e) => setImages(e.target.checked)} /> 이미지·진행 상태도 복사(기본 제외)
        </label>
      </div>
      <p className="small muted">새 ID로 복사하므로 이후 수정은 원본 프로젝트에 영향을 주지 않습니다.</p>
      {!data && !err && <p className="muted">불러오는 중…</p>}
      {data && (
        <div className="table-wrap">
          <table className="ptable">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={chosen.size === data.reactions.length}
                    onChange={() => setChosen(chosen.size === data.reactions.length ? new Set() : new Set(data.reactions.map((r) => r.id)))}
                  />
                </th>
                <th>감정·상태</th>
                <th>표현 설명</th>
                <th>키워드</th>
                <th>태그</th>
              </tr>
            </thead>
            <tbody>
              {data.reactions.map((r) => (
                <tr key={r.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={chosen.has(r.id)}
                      onChange={() => {
                        const n = new Set(chosen)
                        if (n.has(r.id)) n.delete(r.id)
                        else n.add(r.id)
                        setChosen(n)
                      }}
                    />
                  </td>
                  <td>{r.emotion}</td>
                  <td className="small">{r.expression}</td>
                  <td className="small">{r.keyword}</td>
                  <td className="small mono clamp2">{r.tags}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {prog && <Progress {...prog} />}
      {err && <p className="error pre">{err}</p>}
    </Modal>
  )
}

/** 의미가 겹치는 리액션(예: 수줍음/쑥스러움)을 나란히 놓고 판단 */
export function CompareReactionsDialog({ reactions, onClose }: { reactions: Reaction[]; onClose: () => void }) {
  const candidates = useStore((s) => s.candidates)
  const list = reactions.slice(0, 6)
  return (
    <Modal title="리액션 나란히 비교" full onClose={onClose}>
      {reactions.length > 6 && <p className="muted small">처음 6개만 표시합니다.</p>}
      <div className="rcompare" style={{ gridTemplateColumns: `repeat(${list.length}, minmax(180px, 1fr))` }}>
        {list.map((r) => {
          const th = reactionThumb(r, candidates[r.id])
          return (
            <div key={r.id} className="card">
              {th ? <StoredImage path={th.thumb_path} fallbackPath={th.storage_path} alt="" className="thumb-b" /> : <div className="thumb-b empty">이미지 없음</div>}
              <h3>
                {r.emotion || '(감정명 없음)'} <StatusBadge status={r.status} />
              </h3>
              <dl className="small">
                <dt>표현 설명</dt>
                <dd>{r.expression || '—'}</dd>
                <dt>시각 요소</dt>
                <dd>{r.visual.map((v) => v.label || v.tag).join(', ') || '—'}</dd>
                <dt>호출 키워드</dt>
                <dd>{r.keyword || '—'}</dd>
                <dt>태그</dt>
                <dd className="mono">{r.tags || '—'}</dd>
                <dt>메모</dt>
                <dd>{r.memo || '—'}</dd>
              </dl>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}

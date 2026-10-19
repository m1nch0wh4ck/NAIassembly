import { useEffect, useMemo, useRef, useState } from 'react'
import {
  adopt,
  deleteCandidate,
  deleteReactions,
  duplicateReaction,
  edit,
  errMsg,
  getState,
  moveReaction,
  saveOption,
  setStatus,
  sortedReactions,
  toast,
  updateCandidateMemo,
  useStore,
  view,
} from '../data/store'
import { discard, enqueue, retry, useUploads, type UploadItem } from '../data/uploads'
import { copyText } from '../lib/download'
import { formatBytes } from '../lib/format'
import { sanitizeBaseName } from '../lib/filename'
import { appendMissing, composeTags, decideTagSync, tagsNeedReview } from '../lib/tags'
import { CATEGORIES, STATUS_LABEL, categoryLabel, type Candidate, type Reaction, type Status, type VisualItem } from '../types'
import { Modal, StatusBadge, StoredImage, TextField, ask, fmtDate, go } from './common'
import { Warnings, type Dup } from './ProjectView'

export function ReactionEditor({ reaction: r, dup, mobile }: { reaction: Reaction; dup: Dup; mobile?: boolean }) {
  const ent = useStore((s) => s.reactions[r.id])
  const cands = useStore((s) => s.candidates[r.id]) ?? []
  const set = (patch: Partial<Reaction>, delay?: number) => edit<Reaction>('reactions', r.id, patch, delay)
  const [designOpen, setDesignOpen] = useState(!mobile)

  const setVisual = (visual: VisualItem[]) => {
    const d = decideTagSync(r.tags, r.tags_auto, visual)
    if (d.autoApply) set({ visual, tags: d.composed, tags_auto: d.composed })
    else set({ visual })
  }

  const remove = async () => {
    const ok = await ask({
      title: '리액션 삭제',
      body: (
        <p>
          “{r.emotion || '(감정명 없음)'}” 리액션과 등록된 이미지 {cands.length}장을 삭제합니다. 되돌릴 수 없습니다.
        </p>
      ),
      ok: '삭제',
      danger: true,
      typeToConfirm: cands.length ? '삭제' : undefined,
    })
    if (!ok) return
    try {
      await deleteReactions([r.id])
      go(r.project_id, null, true)
      toast('삭제했습니다', 'ok')
    } catch (e) {
      toast(`삭제하지 못했습니다: ${errMsg(e)}`, 'error')
    }
  }

  const move = (delta: number) => {
    const list = sortedReactions(getState()).map(view)
    const i = list.findIndex((x) => x.id === r.id)
    const t = i + delta
    if (t < 0 || t >= list.length) return
    moveReaction(r.id, t)
  }

  const saveState = ent?.saving ? '저장 중…' : ent?.error ? `저장 실패: ${ent.error}` : ent && Object.keys(ent.local).length ? '저장 대기' : '저장됨'

  const status = (
    <div className="status-row">
      {(['todo', 'generated', 'rework'] as Status[]).map((st) => (
        <button
          key={st}
          className={`st-btn st-${st} ${r.status === st ? 'on' : ''}`}
          onClick={async () => {
            if (r.status === st) return
            if (r.status === 'adopted') {
              const ok = await ask({ title: '채택 해제', body: <p>‘{STATUS_LABEL[st]}’(으)로 바꾸면 채택이 해제됩니다. 이미지는 남습니다.</p>, ok: '변경' })
              if (!ok) return
            }
            setStatus(r.id, st)
          }}
        >
          {STATUS_LABEL[st]}
        </button>
      ))}
      <span className={`st-btn st-adopted ${r.status === 'adopted' ? 'on' : ''} passive`} title="채택은 아래 후보 이미지에서 고릅니다">
        채택{r.status === 'adopted' ? ' ✓' : ''}
      </span>
    </div>
  )

  const fileBase = sanitizeBaseName(r.filename || r.emotion, 'png', '(이름 없음)')
  const design = (
    <>
      <div className="grid2">
        <TextField label="감정·상태명" value={r.emotion} onChange={(v) => set({ emotion: v })} placeholder="예: 당황" maxLength={200} />
        <TextField label="호출 키워드" value={r.keyword} onChange={(v) => set({ keyword: v })} placeholder="채팅에서 부를 키워드" maxLength={500} />
      </div>
      <TextField
        label="캐릭터별 표현 설명"
        multiline
        rows={2}
        value={r.expression}
        onChange={(v) => set({ expression: v })}
        placeholder="예: 웃음기가 사라지고 시선을 피함"
      />
      <VisualPicker items={r.visual} onChange={setVisual} />
      <TextField
        label="내보내기 파일명"
        value={r.filename}
        onChange={(v) => set({ filename: v })}
        placeholder={r.emotion ? `비우면 감정명(${r.emotion}) 사용` : '확장자 없이 입력'}
        maxLength={300}
        hint={
          <>
            미리보기: <code>{fileBase.name}.(원본 형식)</code>
            {fileBase.notes.length > 0 && <span className="warn-text"> · {fileBase.notes.join(', ')}</span>}
          </>
        }
      />
    </>
  )

  return (
    <div className={`editor ${mobile ? 'mobile' : ''}`}>
      <div className="ed-head">
        <div>
          <h2>{r.emotion || '(감정명 없음)'}</h2>
          <div className="row gap small">
            <StatusBadge status={r.status} />
            <span className={`muted ${ent?.error ? 'error' : ''}`}>{saveState}</span>
            <Warnings r={r} dup={dup} />
          </div>
        </div>
        {!mobile && (
          <div className="row gap">
            <button className="ghost small" onClick={() => move(-1)} title="위로">
              ↑
            </button>
            <button className="ghost small" onClick={() => move(1)} title="아래로">
              ↓
            </button>
            <button
              className="ghost small"
              onClick={async () => {
                try {
                  const n = await duplicateReaction(r.id)
                  if (n) go(r.project_id, n.id, true)
                } catch (e) {
                  toast(`복제하지 못했습니다: ${errMsg(e)}`, 'error')
                }
              }}
            >
              복제
            </button>
            <button className="ghost small danger-text" onClick={remove}>
              삭제
            </button>
          </div>
        )}
      </div>
      {mobile && r.expression && <p className="m-expr">{r.expression}</p>}

      {mobile ? (
        <>
          <TagPanel r={r} set={set} />
          <Candidates r={r} cands={cands} mobile />
          {status}
          <TextField label="짧은 메모" multiline rows={2} value={r.memo} onChange={(v) => set({ memo: v })} />
          <details className="fold" open={designOpen} onToggle={(e) => setDesignOpen((e.target as HTMLDetailsElement).open)}>
            <summary>설계 정보 편집</summary>
            {design}
            <div className="row gap">
              <button
                onClick={async () => {
                  const n = await duplicateReaction(r.id).catch((e) => toast(errMsg(e), 'error'))
                  if (n) go(r.project_id, n.id, true)
                }}
              >
                복제
              </button>
              <button className="danger" onClick={remove}>
                리액션 삭제
              </button>
            </div>
          </details>
        </>
      ) : (
        <>
          {status}
          {design}
          <TagPanel r={r} set={set} />
          <TextField label="작업 메모" multiline rows={2} value={r.memo} onChange={(v) => set({ memo: v })} />
          <Candidates r={r} cands={cands} />
          <p className="muted small">
            만든 날 {fmtDate(r.created_at)} · 수정 {fmtDate(r.updated_at)} · ID <code>{r.id.slice(0, 8)}</code>
          </p>
        </>
      )}
    </div>
  )
}

// ───────────── 시각 요소 ─────────────

function VisualPicker({ items, onChange }: { items: VisualItem[]; onChange: (v: VisualItem[]) => void }) {
  const options = useStore((s) => s.options)
  const [adding, setAdding] = useState<string | null>(null)
  const upd = (key: string, p: Partial<VisualItem>) => onChange(items.map((x) => (x.key === key ? { ...x, ...p } : x)))
  const del = (key: string) => onChange(items.filter((x) => x.key !== key))
  const add = (it: Omit<VisualItem, 'key'>) => onChange([...items, { ...it, key: crypto.randomUUID() }])
  const used = new Set(items.map((x) => x.option_id).filter(Boolean))
  return (
    <div className="field visual">
      <span>시각 요소</span>
      {items.length === 0 && <p className="muted small">얼굴·시선·입·자세·손동작 등을 선택 항목에서 고르거나 직접 입력하세요.</p>}
      {CATEGORIES.map((cat) => {
        const mine = items.filter((x) => x.category === cat.key)
        if (!mine.length) return null
        return (
          <div key={cat.key} className="vgroup">
            <div className="vcat">{cat.label}</div>
            {mine.map((it) => (
              <VisualRow key={it.key} it={it} upd={upd} del={del} />
            ))}
          </div>
        )
      })}
      {items
        .filter((x) => !CATEGORIES.some((c) => c.key === x.category))
        .map((it) => (
          <VisualRow key={it.key} it={it} upd={upd} del={del} />
        ))}
      <div className="vadd">
        {CATEGORIES.map((c) => (
          <button key={c.key} className={`chip ${adding === c.key ? 'on' : ''}`} onClick={() => setAdding(adding === c.key ? null : c.key)}>
            + {c.label}
          </button>
        ))}
      </div>
      {adding && (
        <div className="vpick card soft">
          <div className="row between">
            <b className="small">{categoryLabel(adding)} — 저장된 선택 항목</b>
            <button className="ghost small" onClick={() => setAdding(null)}>
              닫기
            </button>
          </div>
          <div className="opt-list">
            {options
              .filter((o) => o.category === adding)
              .sort((a, b) => a.sort_order - b.sort_order)
              .map((o) => (
                <button
                  key={o.id}
                  className={`opt ${used.has(o.id) ? 'used' : ''}`}
                  onClick={() => add({ category: o.category, label: o.label, tag: o.tag, option_id: o.id })}
                  title={o.tag}
                >
                  <span>{o.label || '(설명 없음)'}</span>
                  <code>{o.tag || '태그 없음'}</code>
                </button>
              ))}
            {!options.some((o) => o.category === adding) && (
              <p className="muted small">이 분류에 저장된 항목이 없습니다. 설정 → 선택 항목에서 만들거나 아래에서 직접 입력하세요.</p>
            )}
          </div>
          <button onClick={() => add({ category: adding, label: '', tag: '', option_id: null })}>직접 입력 추가</button>
        </div>
      )}
    </div>
  )
}

function VisualRow({ it, upd, del }: { it: VisualItem; upd: (k: string, p: Partial<VisualItem>) => void; del: (k: string) => void }) {
  const options = useStore((s) => s.options)
  const lib = it.option_id ? options.find((o) => o.id === it.option_id) : null
  const changed = lib && (lib.label !== it.label || lib.tag !== it.tag)
  return (
    <div className="vrow">
      <input value={it.label} onChange={(e) => upd(it.key, { label: e.target.value })} placeholder="한국어 설명" aria-label="설명" />
      <input className="mono" value={it.tag} onChange={(e) => upd(it.key, { tag: e.target.value })} placeholder="NAI 태그" aria-label="태그" />
      <div className="vrow-act">
        {!it.option_id && (it.label || it.tag) && (
          <button
            className="ghost small"
            title="선택 항목 라이브러리에 저장"
            onClick={async () => {
              try {
                const o = await saveOption({ category: it.category, label: it.label, tag: it.tag })
                upd(it.key, { option_id: o.id })
                toast('선택 항목에 저장했습니다', 'ok')
              } catch (e) {
                toast(errMsg(e), 'error')
              }
            }}
          >
            저장
          </button>
        )}
        {changed && <span className="muted small" title="라이브러리 원본과 다르게 수정됨(이 리액션에만 적용)">수정됨</span>}
        <button className="ghost small" onClick={() => del(it.key)} aria-label="삭제">
          ✕
        </button>
      </div>
    </div>
  )
}

// ───────────── 태그 ─────────────

function TagPanel({ r, set }: { r: Reaction; set: (p: Partial<Reaction>, d?: number) => void }) {
  const composed = useMemo(() => composeTags(r.visual), [r.visual])
  const review = tagsNeedReview(r.tags, r.tags_auto, r.visual)
  const [copyOpen, setCopyOpen] = useState(false)
  return (
    <div className="field tags">
      <div className="row between">
        <span>NAI 표현 태그</span>
        <button className="primary" onClick={() => setCopyOpen(true)} disabled={!r.tags.trim()}>
          태그 복사
        </button>
      </div>
      <TextField multiline rows={3} mono value={r.tags} onChange={(v) => set({ tags: v })} placeholder="직접 입력하거나 시각 요소에서 조립됩니다" />
      {review && (
        <div className="notice">
          <p className="small">
            시각 요소가 바뀌었지만, 태그를 직접 수정한 적이 있어 <b>자동으로 덮어쓰지 않았습니다</b>.
          </p>
          <p className="small mono">시각 요소 기준: {composed || '(없음)'}</p>
          <div className="row gap wrap">
            <button className="small" onClick={() => set({ tags: appendMissing(r.tags, composed), tags_auto: composed })}>
              빠진 태그만 뒤에 추가
            </button>
            <button
              className="small"
              onClick={async () => {
                const ok = await ask({ title: '태그 다시 만들기', body: <p>직접 수정한 태그를 버리고 시각 요소 기준으로 바꿉니다.</p>, ok: '바꾸기' })
                if (ok) set({ tags: composed, tags_auto: composed })
              }}
            >
              시각 요소 기준으로 바꾸기
            </button>
            <button className="small ghost" onClick={() => set({ tags_auto: composed })}>
              그대로 두기
            </button>
          </div>
        </div>
      )}
      {!review && r.visual.length > 0 && r.tags.trim() !== r.tags_auto.trim() && (
        <small className="hint">직접 수정한 태그입니다. 시각 요소를 바꿔도 자동으로 덮어쓰지 않습니다.</small>
      )}
      {copyOpen && <CopyDialog r={r} set={set} onClose={() => setCopyOpen(false)} />}
    </div>
  )
}

/** 복사 전 최종 확인·수정 */
function CopyDialog({ r, set, onClose }: { r: Reaction; set: (p: Partial<Reaction>, d?: number) => void; onClose: () => void }) {
  const [text, setText] = useState(r.tags)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const changed = text !== r.tags
  return (
    <Modal
      title={`태그 복사 — ${r.emotion || '(감정명 없음)'}`}
      onClose={onClose}
      footer={
        <>
          {changed && (
            <button
              onClick={() => {
                set({ tags: text }, 100)
                toast('리액션 태그에 저장했습니다', 'ok')
              }}
            >
              수정 내용을 리액션에 저장
            </button>
          )}
          <button
            className="primary"
            onClick={async () => {
              const ok = await copyText(text)
              if (ok) {
                setCopied(true)
                toast('복사했습니다', 'ok', 1500)
              } else {
                ref.current?.select()
                toast('자동 복사가 막혔습니다. 선택된 글자를 길게 눌러 복사하세요', 'error')
              }
            }}
          >
            {copied ? '다시 복사' : '복사'}
          </button>
        </>
      }
    >
      <p className="muted small">복사될 최종 내용입니다. 여기서 고친 내용은 ‘리액션에 저장’을 누르지 않으면 이번 복사에만 쓰입니다.</p>
      <textarea ref={ref} className="mono copy-area" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
    </Modal>
  )
}

// ───────────── 후보 이미지 ─────────────

function Candidates({ r, cands, mobile }: { r: Reaction; cands: Candidate[]; mobile?: boolean }) {
  const uploads = useUploads().filter((u) => u.reactionId === r.id && u.state !== 'done')
  const doneUploads = useUploads().filter((u) => u.reactionId === r.id && u.state === 'done')
  const [drag, setDrag] = useState(false)
  const [zoom, setZoom] = useState<number | null>(null)
  const [cmp, setCmp] = useState<Set<string>>(new Set())
  const [cmpOpen, setCmpOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const files = (fl: FileList | null) => {
    const arr = [...(fl ?? [])]
    if (!arr.length) return
    void enqueue(r.project_id, r.id, arr)
  }
  return (
    <div
      className={`cands ${drag ? 'drag' : ''}`}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return
        e.preventDefault()
        setDrag(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return
        setDrag(false)
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        setDrag(false)
        files(e.dataTransfer.files)
      }}
    >
      <div className="row between wrap gap">
        <span className="label">
          후보 이미지 {cands.length}장{r.adopted_candidate_id ? ' · 채택 1' : ''}
        </span>
        <div className="row gap">
          {cmp.size >= 2 && (
            <button onClick={() => setCmpOpen(true)}>선택 {cmp.size}장 비교</button>
          )}
          <button className={mobile ? 'primary big' : 'primary'} onClick={() => input.current?.click()}>
            {mobile ? '이미지 추가' : '파일 선택'}
          </button>
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/*"
          multiple
          hidden
          onChange={(e) => {
            files(e.target.files)
            e.target.value = ''
          }}
        />
      </div>
      {!mobile && <div className="dropzone">여기에 이미지를 끌어 놓으세요 (원본 그대로 보관 · 메타데이터 유지)</div>}
      <div className={`cgrid ${mobile ? 'm' : ''}`}>
        {cands.map((c, i) => (
          <CandidateCard
            key={c.id}
            c={c}
            r={r}
            adopted={r.adopted_candidate_id === c.id}
            onZoom={() => setZoom(i)}
            cmp={cmp.has(c.id)}
            onCmp={() => {
              const n = new Set(cmp)
              if (n.has(c.id)) n.delete(c.id)
              else if (n.size < 4) n.add(c.id)
              else toast('한 번에 4장까지 비교할 수 있습니다')
              setCmp(n)
            }}
          />
        ))}
        {uploads.map((u) => (
          <UploadCard key={u.id} u={u} />
        ))}
        {doneUploads
          .filter((u) => !cands.some((c) => c.id === u.id))
          .map((u) => (
            <UploadCard key={u.id} u={u} />
          ))}
      </div>
      {cands.length === 0 && uploads.length === 0 && <p className="muted small">아직 등록된 이미지가 없습니다.</p>}
      {zoom !== null && cands[zoom] && <Lightbox r={r} cands={cands} index={zoom} setIndex={setZoom} onClose={() => setZoom(null)} />}
      {cmpOpen && (
        <CompareDialog
          r={r}
          cands={cands.filter((c) => cmp.has(c.id))}
          onClose={() => setCmpOpen(false)}
        />
      )}
    </div>
  )
}

async function confirmDeleteCandidate(c: Candidate, adopted: boolean) {
  const ok = await ask({
    title: '후보 이미지 삭제',
    body: (
      <>
        <p>“{c.original_name}” 이미지를 삭제합니다. 되돌릴 수 없습니다.</p>
        {adopted && (
          <p className="error">
            <b>채택된 이미지입니다.</b> 삭제하면 이 리액션의 채택이 해제됩니다.
          </p>
        )}
      </>
    ),
    ok: '삭제',
    danger: true,
    typeToConfirm: adopted ? '삭제' : undefined,
  })
  if (!ok) return false
  try {
    await deleteCandidate(c)
    toast('삭제했습니다', 'ok')
    return true
  } catch (e) {
    toast(`삭제하지 못했습니다: ${errMsg(e)}`, 'error')
    return false
  }
}

function CandidateCard(p: { c: Candidate; r: Reaction; adopted: boolean; onZoom: () => void; cmp: boolean; onCmp: () => void }) {
  const { c } = p
  return (
    <div className={`ccard ${p.adopted ? 'adopted' : ''}`}>
      <div className="cimg" onClick={p.onZoom}>
        <StoredImage path={c.thumb_path} fallbackPath={c.storage_path} alt={c.original_name} />
        {p.adopted && <span className="adopt-flag">채택</span>}
      </div>
      <div className="cmeta small">
        <div className="clamp1" title={c.original_name}>
          {c.original_name}
        </div>
        <div className="muted">
          {c.ext.toUpperCase()} · {formatBytes(c.byte_size)}
          {c.width ? ` · ${c.width}×${c.height}` : ''}
        </div>
      </div>
      <CandidateMemo c={c} />
      <div className="cact">
        <button className={p.adopted ? 'on' : 'primary'} onClick={() => adopt(p.r.id, p.adopted ? null : c.id)}>
          {p.adopted ? '채택 해제' : '채택'}
        </button>
        <label className="cmp-check" title="비교에 추가">
          <input type="checkbox" checked={p.cmp} onChange={p.onCmp} /> 비교
        </label>
        <button className="ghost danger-text" onClick={() => void confirmDeleteCandidate(c, p.adopted)} aria-label="삭제">
          삭제
        </button>
      </div>
    </div>
  )
}

function CandidateMemo({ c }: { c: Candidate }) {
  const [v, setV] = useState(c.memo)
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => setV(c.memo), [c.memo])
  const save = (text: string) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      setState('saving')
      try {
        await updateCandidateMemo(c, text)
        setState('idle')
      } catch (e) {
        setState('error')
        toast(`메모 저장 실패: ${errMsg(e)}`, 'error')
      }
    }, 700)
  }
  return (
    <div className="cmemo">
      <input
        value={v}
        placeholder="후보 메모"
        onChange={(e) => {
          setV(e.target.value)
          save(e.target.value)
        }}
      />
      {state !== 'idle' && <span className={`small ${state === 'error' ? 'error' : 'muted'}`}>{state === 'saving' ? '저장 중' : '실패'}</span>}
    </div>
  )
}

function UploadCard({ u }: { u: UploadItem }) {
  const label: Record<UploadItem['state'], string> = { queued: '대기 중', uploading: '업로드 중', done: '완료', failed: '실패' }
  return (
    <div className={`ccard upload up-${u.state}`}>
      <div className="cimg up-ph">
        <span>{label[u.state]}</span>
        {u.state === 'uploading' && <small>{u.stage}</small>}
      </div>
      <div className="cmeta small">
        <div className="clamp1">{u.name}</div>
        <div className="muted">{formatBytes(u.size)}</div>
        {u.error && <div className="error">{u.error}</div>}
      </div>
      {u.state === 'failed' && (
        <div className="cact">
          {!u.fatal && (
            <button className="primary" onClick={() => retry(u.id)}>
              다시 시도
            </button>
          )}
          <button className="ghost" onClick={() => void discard(u.id)}>
            취소
          </button>
        </div>
      )}
    </div>
  )
}

function Lightbox(p: { r: Reaction; cands: Candidate[]; index: number; setIndex: (i: number) => void; onClose: () => void }) {
  const c = p.cands[p.index]
  const [actual, setActual] = useState(false)
  const adopted = p.r.adopted_candidate_id === c.id
  const touch = useRef<number | null>(null)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && p.index > 0) p.setIndex(p.index - 1)
      if (e.key === 'ArrowRight' && p.index < p.cands.length - 1) p.setIndex(p.index + 1)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [p])
  return (
    <Modal title={`${p.r.emotion || '후보'} — ${p.index + 1}/${p.cands.length}`} onClose={p.onClose} full>
      <div
        className={`lb ${actual ? 'actual' : ''}`}
        onTouchStart={(e) => (touch.current = e.touches[0].clientX)}
        onTouchEnd={(e) => {
          if (touch.current === null || actual) return
          const dx = e.changedTouches[0].clientX - touch.current
          touch.current = null
          if (dx > 60 && p.index > 0) p.setIndex(p.index - 1)
          if (dx < -60 && p.index < p.cands.length - 1) p.setIndex(p.index + 1)
        }}
      >
        <StoredImage key={c.id} path={c.storage_path} alt={c.original_name} onClick={() => setActual(!actual)} />
      </div>
      <div className="lb-bar">
        <button disabled={p.index === 0} onClick={() => p.setIndex(p.index - 1)}>
          ‹ 이전
        </button>
        <button onClick={() => setActual(!actual)}>{actual ? '화면에 맞춤' : '원본 크기'}</button>
        <button className={adopted ? 'on' : 'primary'} onClick={() => adopt(p.r.id, adopted ? null : c.id)}>
          {adopted ? '채택 해제' : '이 이미지 채택'}
        </button>
        <button disabled={p.index >= p.cands.length - 1} onClick={() => p.setIndex(p.index + 1)}>
          다음 ›
        </button>
      </div>
      <p className="small muted center">
        {c.original_name} · {c.ext.toUpperCase()} · {formatBytes(c.byte_size)} {c.width ? `· ${c.width}×${c.height}` : ''} · 등록 {fmtDate(c.created_at)}
        {c.memo && ` · 메모: ${c.memo}`}
      </p>
    </Modal>
  )
}

function CompareDialog({ r, cands, onClose }: { r: Reaction; cands: Candidate[]; onClose: () => void }) {
  return (
    <Modal title={`후보 비교 — ${r.emotion}`} onClose={onClose} full>
      <div className={`compare n${cands.length}`}>
        {cands.map((c) => {
          const adopted = r.adopted_candidate_id === c.id
          return (
            <div key={c.id} className={`cmp-col ${adopted ? 'adopted' : ''}`}>
              <StoredImage path={c.storage_path} alt={c.original_name} />
              <div className="small clamp1">{c.original_name}</div>
              {c.memo && <div className="small muted">{c.memo}</div>}
              <button className={adopted ? 'on' : 'primary'} onClick={() => adopt(r.id, adopted ? null : c.id)}>
                {adopted ? '채택됨 · 해제' : '채택'}
              </button>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}

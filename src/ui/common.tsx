import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { STATUS_LABEL, type Status } from '../types'
import { cachedUrl, signedUrl } from '../data/transfer'

export function useMedia(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const h = () => setM(mq.matches)
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [q])
  return m
}

export const useMobile = () => useMedia('(max-width: 899px)')

/** #/p/<프로젝트>/r/<리액션> 형식의 주소 */
export function useRoute() {
  const parse = () => {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
    const r: { project: string | null; reaction: string | null } = { project: null, reaction: null }
    for (let i = 0; i < parts.length; i += 2) {
      if (parts[i] === 'p') r.project = parts[i + 1] ?? null
      if (parts[i] === 'r') r.reaction = parts[i + 1] ?? null
    }
    return r
  }
  const [route, setRoute] = useState(parse)
  useEffect(() => {
    const h = () => setRoute(parse())
    window.addEventListener('hashchange', h)
    return () => window.removeEventListener('hashchange', h)
  }, [])
  return route
}

export function go(project: string | null, reaction: string | null = null, replace = false) {
  const h = project ? `#/p/${project}${reaction ? `/r/${reaction}` : ''}` : '#/'
  if (replace) history.replaceState(null, '', h)
  else location.hash = h
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'))
}

export function Modal(props: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  full?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('keydown', h)
    ref.current?.focus()
    return () => window.removeEventListener('keydown', h)
  }, [props.onClose])
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.wide ? 'wide' : ''} ${props.full ? 'full' : ''}`} role="dialog" aria-modal="true" aria-label={props.title} tabIndex={-1} ref={ref}>
        <div className="modal-head">
          <h2>{props.title}</h2>
          <button className="ghost icon" onClick={props.onClose} aria-label="닫기">
            ✕
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  )
}

type ConfirmReq = {
  title: string
  body: ReactNode
  ok: string
  danger?: boolean
  typeToConfirm?: string
  resolve: (v: boolean) => void
}
let pushConfirm: ((r: ConfirmReq) => void) | null = null

/** 되돌릴 수 없는 작업 전 확인. typeToConfirm을 주면 그 글자를 입력해야 실행됩니다. */
export function ask(opts: Omit<ConfirmReq, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    if (!pushConfirm) return resolve(window.confirm(String(opts.title)))
    pushConfirm({ ...opts, resolve })
  })
}

export function ConfirmHost() {
  const [req, setReq] = useState<ConfirmReq | null>(null)
  const [typed, setTyped] = useState('')
  useEffect(() => {
    pushConfirm = (r) => {
      setTyped('')
      setReq(r)
    }
    return () => {
      pushConfirm = null
    }
  }, [])
  if (!req) return null
  const done = (v: boolean) => {
    req.resolve(v)
    setReq(null)
  }
  const blocked = !!req.typeToConfirm && typed.trim() !== req.typeToConfirm.trim()
  return (
    <Modal
      title={req.title}
      onClose={() => done(false)}
      footer={
        <>
          <button onClick={() => done(false)}>취소</button>
          <button className={req.danger ? 'danger' : 'primary'} disabled={blocked} onClick={() => done(true)}>
            {req.ok}
          </button>
        </>
      }
    >
      <div className="confirm-body">{req.body}</div>
      {req.typeToConfirm && (
        <label className="field">
          <span>
            확인을 위해 <b>{req.typeToConfirm}</b> 을(를) 입력하세요
          </span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </label>
      )}
    </Modal>
  )
}

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge st-${status}`}>{STATUS_LABEL[status]}</span>
}

/** 비공개 저장소 이미지(서명 URL로 표시) */
export function StoredImage(props: { path: string | null; alt: string; className?: string; onClick?: () => void; fallbackPath?: string | null }) {
  const path = props.path ?? props.fallbackPath ?? null
  const [url, setUrl] = useState<string | null>(() => (path ? cachedUrl(path) : null))
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    setFailed(false)
    if (!path) return
    const c = cachedUrl(path)
    if (c) setUrl(c)
    else void signedUrl(path).then((u) => alive && (u ? setUrl(u) : setFailed(true)))
    return () => {
      alive = false
    }
  }, [path])
  if (!path) return <div className={`img-ph ${props.className ?? ''}`}>이미지 없음</div>
  if (failed) return <div className={`img-ph ${props.className ?? ''}`}>불러오기 실패</div>
  if (!url) return <div className={`img-ph loading ${props.className ?? ''}`} />
  return (
    <img
      src={url}
      alt={props.alt}
      className={props.className}
      onClick={props.onClick}
      loading="lazy"
      decoding="async"
      onError={() => {
        if (props.fallbackPath && path !== props.fallbackPath) setUrl(null)
        setFailed(true)
      }}
    />
  )
}

export function fmtDate(s: string) {
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function Progress({ done, total, label }: { done: number; total: number; label: string }) {
  const pct = total ? Math.round((done / total) * 100) : 0
  return (
    <div className="progress">
      <div className="bar">
        <div style={{ width: `${pct}%` }} />
      </div>
      <div className="muted small">
        {done}/{total} · {label}
      </div>
    </div>
  )
}

/** 입력 중에는 로컬 값을 유지하고, 바뀔 때마다 onChange(저장 예약)를 호출하는 입력란 */
export function TextField(props: {
  label?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  multiline?: boolean
  rows?: number
  hint?: ReactNode
  className?: string
  mono?: boolean
  maxLength?: number
}) {
  const [v, setV] = useState(props.value)
  const id = useId()
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setV(props.value)
  }, [props.value])
  const common = {
    value: v,
    placeholder: props.placeholder,
    maxLength: props.maxLength,
    className: props.mono ? 'mono' : undefined,
    onFocus: () => (focused.current = true),
    onBlur: () => {
      focused.current = false
      setV(props.value)
    },
    onChange: (e: { target: { value: string } }) => {
      setV(e.target.value)
      props.onChange(e.target.value)
    },
  }
  return (
    <div className={`field ${props.className ?? ''}`}>
      {props.label && <label htmlFor={id}>{props.label}</label>}
      {props.multiline ? <textarea id={id} rows={props.rows ?? 3} {...common} /> : <input id={id} {...common} />}
      {props.hint && <small className="hint">{props.hint}</small>}
    </div>
  )
}

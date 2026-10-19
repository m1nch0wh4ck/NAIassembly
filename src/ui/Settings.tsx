import { useState } from 'react'
import type { AppConfig } from '../config'
import { clearDeviceConfig } from '../config'
import { deleteOption, errMsg, saveOption, saveOptions, toast, useStore } from '../data/store'
import { checkStorage, removeOrphans, type StorageReport } from '../data/transfer'
import { useUploads } from '../data/uploads'
import { formatBytes } from '../lib/format'
import { CATEGORIES, type VisualOption } from '../types'
import { Modal, ask } from './common'
import { EXAMPLE_OPTIONS } from './examples'

export function SettingsDialog({ config, onClose, onSignOut }: { config: AppConfig; onClose: () => void; onSignOut: () => void }) {
  const [tab, setTab] = useState<'options' | 'storage' | 'account'>('options')
  const session = useStore((s) => s.session)
  return (
    <Modal title="설정" wide onClose={onClose}>
      <div className="seg tabs">
        <button className={tab === 'options' ? 'on' : ''} onClick={() => setTab('options')}>
          선택 항목(표정·몸짓)
        </button>
        <button className={tab === 'storage' ? 'on' : ''} onClick={() => setTab('storage')}>
          저장 공간 점검
        </button>
        <button className={tab === 'account' ? 'on' : ''} onClick={() => setTab('account')}>
          계정·접속
        </button>
      </div>
      {tab === 'options' && <OptionLibrary />}
      {tab === 'storage' && <StorageCheck />}
      {tab === 'account' && (
        <div>
          <p>
            로그인: <b>{session?.user.email}</b>
          </p>
          <p className="small muted">
            저장 서비스: {config.url} ({config.source === 'env' ? '배포 설정' : '이 기기에 입력한 설정'})
          </p>
          <div className="row gap">
            <button onClick={onSignOut}>로그아웃</button>
            {config.source === 'device' && (
              <button
                onClick={() => {
                  clearDeviceConfig()
                  location.reload()
                }}
              >
                이 기기의 접속 설정 지우기
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

function OptionLibrary() {
  const options = useStore((s) => s.options)
  const [cat, setCat] = useState(CATEGORIES[0].key)
  const list = options.filter((o) => o.category === cat).sort((a, b) => a.sort_order - b.sort_order)
  const [label, setLabel] = useState('')
  const [tag, setTag] = useState('')
  const add = async () => {
    if (!label.trim() && !tag.trim()) return
    try {
      await saveOption({ category: cat, label: label.trim(), tag: tag.trim() })
      setLabel('')
      setTag('')
    } catch (e) {
      toast(errMsg(e), 'error')
    }
  }
  const addExamples = async () => {
    const ok = await ask({
      title: '예시 항목 추가',
      body: (
        <>
          <p>분류별 예시 항목 {EXAMPLE_OPTIONS.length}개를 내 선택 항목에 추가합니다.</p>
          <p className="small">
            예시의 태그는 흔히 쓰이는 영어 태그 표기를 참고한 <b>출발점</b>일 뿐이며, NovelAI V5에서 의도대로 동작한다고 검증된 공식 태그가 아닙니다. 직접
            생성해 보고 고쳐 쓰세요.
          </p>
        </>
      ),
      ok: '추가',
    })
    if (!ok) return
    try {
      await saveOptions(EXAMPLE_OPTIONS)
      toast('예시 항목을 추가했습니다', 'ok')
    } catch (e) {
      toast(errMsg(e), 'error')
    }
  }
  return (
    <div>
      <p className="small muted">
        리액션의 ‘시각 요소’에서 골라 쓰는 재사용 목록입니다. 한국어 설명과 NAI 태그를 따로 저장합니다. 여기서 고쳐도 이미 리액션에 넣은 값은 바뀌지
        않습니다(리액션마다 복사본).
      </p>
      <div className="chips">
        {CATEGORIES.map((c) => (
          <button key={c.key} className={`chip ${cat === c.key ? 'on' : ''}`} onClick={() => setCat(c.key)}>
            {c.label} {options.filter((o) => o.category === c.key).length}
          </button>
        ))}
      </div>
      <div className="opt-edit">
        {list.map((o) => (
          <OptionRow key={o.id} o={o} />
        ))}
        {!list.length && <p className="muted small">이 분류에 항목이 없습니다.</p>}
        <div className="vrow">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="한국어 설명 (예: 시선 회피)" />
          <input className="mono" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="NAI 태그 (직접 확인한 표기)" onKeyDown={(e) => e.key === 'Enter' && add()} />
          <button className="primary" onClick={add}>
            추가
          </button>
        </div>
      </div>
      {options.length === 0 && (
        <button className="ghost" onClick={addExamples}>
          예시 항목으로 시작하기(검증 안 된 예시)
        </button>
      )}
    </div>
  )
}

function OptionRow({ o }: { o: VisualOption }) {
  const [label, setLabel] = useState(o.label)
  const [tag, setTag] = useState(o.tag)
  const dirty = label !== o.label || tag !== o.tag
  return (
    <div className="vrow">
      <input value={label} onChange={(e) => setLabel(e.target.value)} />
      <input className="mono" value={tag} onChange={(e) => setTag(e.target.value)} />
      <div className="vrow-act">
        {dirty && (
          <button className="primary small" onClick={() => saveOption({ ...o, label, tag }).catch((e) => toast(errMsg(e), 'error'))}>
            저장
          </button>
        )}
        <button
          className="ghost small"
          aria-label="삭제"
          onClick={async () => {
            if (await ask({ title: '선택 항목 삭제', body: <p>“{o.label}”을(를) 목록에서 지웁니다. 이미 리액션에 넣은 값은 남습니다.</p>, ok: '삭제', danger: true }))
              deleteOption(o.id).catch((e) => toast(errMsg(e), 'error'))
          }}
        >
          ✕
        </button>
      </div>
    </div>
  )
}

function StorageCheck() {
  const uploads = useUploads()
  const [rep, setRep] = useState<StorageReport | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      setRep(await checkStorage())
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const active = new Set(uploads.filter((u) => u.state !== 'done').map((u) => u.id))
  const orphans = rep?.orphans.filter((p) => !active.has(p.split('/').pop()!.split('.')[0])) ?? []
  return (
    <div>
      <p className="small muted">
        내 저장 공간의 파일과 기록을 대조합니다. 무료 플랜 파일 저장 한도는 프로젝트당 1GB입니다(README 참고). 기록 없이 남은 파일(업로드 중단·삭제
        실패)은 정리할 수 있습니다.
      </p>
      <button onClick={run} disabled={busy}>
        {busy ? '점검 중…' : '점검 시작'}
      </button>
      {rep && (
        <div className="card soft">
          <p>
            파일 {rep.files}개 · {formatBytes(rep.bytes)}
          </p>
          <p>
            기록 없는 파일: {orphans.length}개{' '}
            {orphans.length > 0 && (
              <button
                className="small"
                onClick={async () => {
                  if (!(await ask({ title: '정리', body: <p>기록이 없는 파일 {orphans.length}개를 삭제합니다.</p>, ok: '삭제', danger: true }))) return
                  await removeOrphans(orphans)
                  void run()
                }}
              >
                정리
              </button>
            )}
          </p>
          <p className={rep.missing.length ? 'error' : ''}>파일이 사라진 기록: {rep.missing.length}개</p>
          {rep.missing.length > 0 && (
            <ul className="small">
              {rep.missing.slice(0, 20).map((c) => (
                <li key={c.id}>{c.original_name}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

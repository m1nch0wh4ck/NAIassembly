import { useState } from 'react'
import { looksSecret, saveDeviceConfig } from '../config'

/** 빌드 환경 변수가 없을 때: 이 기기에 접속 정보를 입력(로컬 실행·임시 사용용) */
export function SetupScreen() {
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [err, setErr] = useState('')
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!/^https?:\/\/.+/.test(url.trim())) return setErr('Project URL을 https://로 시작하는 주소로 입력하세요')
    if (!key.trim()) return setErr('공개 키를 입력하세요')
    if (looksSecret(key.trim())) return setErr('비밀 키(secret / service_role)입니다. 절대 앱에 넣지 마세요. Publishable(또는 anon) 키를 입력하세요.')
    saveDeviceConfig(url, key)
    location.reload()
  }
  return (
    <div className="center-page">
      <form className="card login" onSubmit={submit}>
        <h1>리액션 작업실 · 접속 설정</h1>
        <p className="muted">
          저장 서비스(Supabase) 접속 정보가 아직 없습니다. 보통은 GitHub 저장소 설정에 넣어 배포하며(README 참고), 이 화면은 그 전에 이
          기기에서만 임시로 쓰는 용도입니다.
        </p>
        <label className="field">
          <span>Project URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://xxxx.supabase.co" autoComplete="off" />
        </label>
        <label className="field">
          <span>Publishable key (또는 anon key)</span>
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="sb_publishable_…" autoComplete="off" />
        </label>
        {err && <p className="error">{err}</p>}
        <button className="primary" type="submit">
          저장하고 시작
        </button>
      </form>
    </div>
  )
}

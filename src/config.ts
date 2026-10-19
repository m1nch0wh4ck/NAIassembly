// 접속 설정. 빌드 시 환경 변수(VITE_…)가 우선이고, 없으면 이 기기에 저장된 값을 씁니다.
// 여기에 들어가는 값은 공개용(publishable/anon) 키뿐입니다. 비밀 키는 앱 어디에도 넣지 않습니다.

export interface AppConfig {
  url: string
  key: string
  source: 'env' | 'device'
}

const LS_KEY = 'nra:config'

export function getConfig(): AppConfig | null {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined
  if (url && key) return { url, key, source: 'env' }
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const v = JSON.parse(raw)
    if (typeof v?.url === 'string' && typeof v?.key === 'string') return { url: v.url, key: v.key, source: 'device' }
  } catch {
    /* 저장소 사용 불가 */
  }
  return null
}

export function looksSecret(key: string) {
  if (key.startsWith('sb_secret_')) return true
  // 구형 JWT 키: payload의 role이 service_role이면 거부
  const parts = key.split('.')
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
      return payload?.role === 'service_role'
    } catch {
      return false
    }
  }
  return false
}

export function saveDeviceConfig(url: string, key: string) {
  localStorage.setItem(LS_KEY, JSON.stringify({ url: url.trim().replace(/\/+$/, ''), key: key.trim() }))
}

export function clearDeviceConfig() {
  localStorage.removeItem(LS_KEY)
}

export const BUCKET = 'reaction-images'

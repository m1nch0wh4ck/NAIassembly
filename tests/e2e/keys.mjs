// 로컬 검증용 키(실제 서비스와 무관한 테스트 전용 값)
import { createHmac } from 'node:crypto'
export const JWT_SECRET = 'local-test-jwt-secret-with-at-least-32-characters'
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
export function sign(payload) {
  const h = b64({ alg: 'HS256', typ: 'JWT' })
  const p = b64(payload)
  const s = createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')
  return `${h}.${p}.${s}`
}
const exp = Math.floor(Date.now() / 1000) + 3600 * 24 * 365
export const ANON_KEY = sign({ iss: 'supabase-demo', role: 'anon', exp })
export const SERVICE_KEY = sign({ iss: 'supabase-demo', role: 'service_role', exp })

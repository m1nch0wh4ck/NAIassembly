import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { AppConfig } from './config'

let client: SupabaseClient | null = null

export function initClient(cfg: AppConfig): SupabaseClient {
  client = createClient(cfg.url, cfg.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'nra-auth' },
  })
  return client
}

export function sb(): SupabaseClient {
  if (!client) throw new Error('저장 서비스가 설정되지 않았습니다')
  return client
}

// 실제 Supabase 구성요소(GoTrue·PostgREST·Storage API)에 대해 앱과 같은 supabase-js로 접근 제어·바이트 보존을 검증합니다.
// 실행: node tests/e2e/api.test.mjs  (stack.sh 실행 중이어야 함)
import { createClient } from '@supabase/supabase-js'
import { createHash, randomUUID } from 'node:crypto'
import { ANON_KEY, SERVICE_KEY } from './keys.mjs'
import { pngWithMetadata, readPngText } from './png.mjs'

const URL = process.env.SB_URL ?? 'http://127.0.0.1:54321'
const BUCKET = 'reaction-images'
let failed = 0
const ok = (c, m) => {
  if (c) console.log('PASS', m)
  else {
    failed++
    console.log('FAIL', m)
  }
}
const sha = (b) => createHash('sha256').update(b).digest('hex')

const admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } })
async function user(email) {
  await admin.auth.admin.createUser({ email, password: 'pw-123456', email_confirm: true }).catch(() => {})
  const c = createClient(URL, ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await c.auth.signInWithPassword({ email, password: 'pw-123456' })
  if (error) throw error
  return { c, id: data.user.id }
}

const A = await user(`a-${Date.now()}@test.local`)
const B = await user(`b-${Date.now()}@test.local`)

// 가입 차단 확인
{
  const anon = createClient(URL, ANON_KEY, { auth: { persistSession: false } })
  const { error } = await anon.auth.signUp({ email: `x-${Date.now()}@test.local`, password: 'pw-123456' })
  ok(!!error, '가입 비활성화 시 새 계정 생성 불가')
  const { data, error: e2 } = await anon.from('projects').select('*')
  ok(!!e2 || (data ?? []).length === 0, '비로그인(anon 키)으로 프로젝트 조회 불가')
}

// A: 프로젝트·리액션 생성
const pid = randomUUID()
const rid = randomUUID()
{
  const { error } = await A.c.from('projects').insert({ id: pid, name: '하루', character_name: '하루' })
  ok(!error, '소유자 프로젝트 생성')
  const { error: e2 } = await A.c.from('reactions').insert({ id: rid, project_id: pid, emotion: '당황', keyword: '당황', tags: 'blush' })
  ok(!e2, '소유자 리액션 생성')
}

// 원본 업로드 → 다운로드 바이트 동일
const png = pngWithMetadata()
const cid = randomUUID()
const path = `${A.id}/${pid}/${rid}/${cid}.png`
{
  const { error } = await A.c.storage.from(BUCKET).upload(path, new Blob([png], { type: 'image/png' }), { contentType: 'image/png', upsert: true })
  ok(!error, `원본 업로드 ${error?.message ?? ''}`)
  const { data, error: e2 } = await A.c.storage.from(BUCKET).download(path)
  const back = new Uint8Array(await data.arrayBuffer())
  ok(!e2 && sha(back) === sha(png), '다운로드한 원본의 SHA-256이 업로드 전과 같음')
  ok(readPngText(back).Comment?.includes('1girl'), 'PNG tEXt 메타데이터(Comment) 유지')
  const { error: e3 } = await A.c.from('candidates').insert({
    id: cid, project_id: pid, reaction_id: rid, storage_path: path, original_name: 'nai.png', mime_type: 'image/png', ext: 'png', byte_size: png.length, sha256: sha(png),
  })
  ok(!e3, '후보 기록 저장')
  const { data: r } = await A.c.from('reactions').select('status,version').eq('id', rid).single()
  ok(r.status === 'generated', '첫 이미지 등록 후 상태가 생성됨')
  // 버전 확인 갱신
  const { data: upd } = await A.c.from('reactions').update({ emotion: '오래된 화면', version: 2 }).eq('id', rid).eq('version', 1).select().maybeSingle()
  ok(upd === null, '오래된 버전으로 저장 시 0행(충돌 감지)')
  const { data: upd2 } = await A.c.from('reactions').update({ status: 'adopted', adopted_candidate_id: cid, version: r.version + 1 }).eq('id', rid).eq('version', r.version).select().maybeSingle()
  ok(upd2?.status === 'adopted', '최신 버전으로 채택 저장')
  const { data: signed } = await A.c.storage.from(BUCKET).createSignedUrls([path], 60)
  const res = await fetch(signed[0].signedUrl.startsWith('http') ? signed[0].signedUrl : URL + '/storage/v1' + signed[0].signedUrl)
  ok(res.ok && sha(new Uint8Array(await res.arrayBuffer())) === sha(png), '서명 URL로 받은 이미지도 원본과 동일')
}

// B: A의 데이터·이미지 접근 불가
{
  const { data: ps } = await B.c.from('projects').select('*')
  ok(ps.length === 0, 'B는 A의 프로젝트를 볼 수 없음')
  const { data: rs } = await B.c.from('reactions').select('*').eq('id', rid)
  ok(rs.length === 0, 'B는 A의 리액션을 볼 수 없음')
  const { data: u } = await B.c.from('reactions').update({ emotion: 'hacked' }).eq('id', rid).select()
  ok((u ?? []).length === 0, 'B는 A의 리액션을 수정할 수 없음')
  const { data: d, error } = await B.c.storage.from(BUCKET).download(path)
  ok(!!error && !d, 'B는 A의 이미지를 내려받을 수 없음')
  const { data: s } = await B.c.storage.from(BUCKET).createSignedUrls([path], 60)
  ok(!s?.[0]?.signedUrl, 'B는 A의 이미지 서명 URL을 만들 수 없음')
  const { error: ue } = await B.c.storage.from(BUCKET).upload(path, new Blob([new Uint8Array([1, 2, 3])]), { upsert: true })
  ok(!!ue, 'B는 A의 이미지를 덮어쓸 수 없음')
  const { data: rm } = await B.c.storage.from(BUCKET).remove([path])
  ok((rm ?? []).length === 0, 'B는 A의 이미지를 지울 수 없음')
  const { data: again } = await A.c.storage.from(BUCKET).download(path)
  ok(sha(new Uint8Array(await again.arrayBuffer())) === sha(png), 'B의 시도 후에도 A의 원본은 그대로')
  const { error: le } = await B.c.storage.from(BUCKET).upload(`${A.id}/evil.png`, new Blob([png]), {})
  ok(!!le, 'B는 A의 폴더에 파일을 만들 수 없음')
  const { data: list } = await B.c.storage.from(BUCKET).list(A.id)
  ok((list ?? []).length === 0, 'B는 A의 폴더 목록을 볼 수 없음')
  const anon = createClient(URL, ANON_KEY, { auth: { persistSession: false } })
  const { error: ae } = await anon.storage.from(BUCKET).download(path)
  ok(!!ae, '비로그인 사용자는 이미지를 받을 수 없음')
  const pub = await fetch(`${URL}/storage/v1/object/public/${BUCKET}/${path}`)
  ok(!pub.ok, '공개 URL로는 이미지에 접근할 수 없음(비공개 버킷)')
}

// 채택 이미지 삭제 → 채택 해제
{
  await A.c.from('candidates').delete().eq('id', cid)
  const { data: r } = await A.c.from('reactions').select('status,adopted_candidate_id').eq('id', rid).single()
  ok(r.status === 'todo' && r.adopted_candidate_id === null, '채택 이미지 삭제 시 채택 해제(남은 후보 없음 → 미작업)')
  await A.c.storage.from(BUCKET).remove([path])
}

await A.c.from('projects').delete().eq('id', pid)
console.log(failed ? `\n${failed} FAILED` : '\nALL API TESTS PASSED')
process.exit(failed ? 1 : 0)

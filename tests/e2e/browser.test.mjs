// 브라우저 E2E: PC 화면과 모바일 화면(두 기기)에서 같은 계정으로 실제 로컬 Supabase 호환 스택을 사용합니다.
// 실행 전: stack.sh 로 스택 실행, 앱을 VITE_SUPABASE_* 로 빌드해 4173 포트에서 미리보기.
import { chromium, devices } from 'playwright-core'
import { createClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { unzipSync, zipSync, strToU8 } from 'fflate'
import { SERVICE_KEY } from './keys.mjs'
import { pngWithMetadata, readPngText } from './png.mjs'

const APP = process.env.APP_URL ?? 'http://127.0.0.1:4173/'
const SB = process.env.SB_URL ?? 'http://127.0.0.1:54321'
const OUT = process.env.OUT_DIR ?? '/tmp/nra-e2e'
const EXE = process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
mkdirSync(OUT, { recursive: true })

let failed = 0
const ok = (c, m) => {
  if (c) console.log('PASS', m)
  else {
    failed++
    console.log('FAIL', m)
  }
}
const sha = (b) => createHash('sha256').update(b).digest('hex')

const admin = createClient(SB, SERVICE_KEY, { auth: { persistSession: false } })
const stamp = Date.now()
const EMAIL = `owner-${stamp}@test.local`
const EMAIL_B = `other-${stamp}@test.local`
const PW = 'pw-123456'
const { data: created } = await admin.auth.admin.createUser({ email: EMAIL, password: PW, email_confirm: true })
const OWNER = created.user.id
await admin.auth.admin.createUser({ email: EMAIL_B, password: PW, email_confirm: true })

// 테스트 이미지: NovelAI처럼 메타데이터가 들어 있는 PNG
const files = [1, 2, 3, 4].map((seed) => {
  const b = pngWithMetadata(96, 72, seed, { Comment: `{"prompt":"1girl, test ${seed}","seed":${seed}}`, Software: 'NovelAI' })
  const p = `${OUT}/nai-${seed}.png`
  writeFileSync(p, b)
  return { path: p, bytes: b }
})

const browser = await chromium.launch({ executablePath: EXE })
const pc = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] })
const mobile = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] })
const pcPage = await pc.newPage()
const mPage = await mobile.newPage()
for (const [n, p] of [['PC', pcPage], ['모바일', mPage]]) {
  p.on('pageerror', (e) => console.log(`[${n} 페이지 오류]`, e.message))
  p.on('dialog', (d) => d.accept())
}

async function login(page, email = EMAIL) {
  await page.goto(APP)
  await page.getByLabel('이메일').fill(email)
  await page.getByLabel('비밀번호').fill(PW)
  await page.getByRole('button', { name: '로그인' }).click()
  await page.getByRole('heading', { name: '캐릭터 프로젝트' }).waitFor()
}
const saved = (page) => page.locator('.sync.ok').waitFor({ timeout: 15000 })
async function typeField(page, label, value) {
  const f = page.locator('.editor').getByLabel(label, { exact: true })
  await f.fill(value)
}
async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false })
}

// ───── 1. PC: 빈 화면 안내 → 프로젝트·리액션 설계 ─────
await login(pcPage)
ok(await pcPage.getByText('처음 오셨네요').waitFor({ timeout: 8000 }).then(() => true, () => false), '처음에는 빈 화면과 사용 안내 표시')
await shot(pcPage, '01-pc-empty')
await pcPage.getByRole('button', { name: '첫 프로젝트 만들기' }).click()
await pcPage.getByLabel('프로젝트명').fill('하루 리액션')
await pcPage.getByLabel('캐릭터명').fill('하루')
await pcPage.getByRole('button', { name: '만들기', exact: true }).click()
await pcPage.getByText('리액션이 아직 없습니다').waitFor()
const projectUrl = pcPage.url()

async function addReaction(page, data) {
  const before = await page.locator('.rtable tbody tr').count()
  await page.getByRole('button', { name: '+ 리액션' }).first().click()
  await page.locator('.rtable tbody tr').nth(before).waitFor()
  await page.locator('.editor h2', { hasText: '(감정명 없음)' }).waitFor()
  await typeField(page, '감정·상태명', data.emotion)
  await typeField(page, '호출 키워드', data.keyword)
  await typeField(page, '캐릭터별 표현 설명', data.expression)
  if (data.filename !== undefined) await typeField(page, '내보내기 파일명', data.filename)
  await saved(page)
}
await addReaction(pcPage, { emotion: '당황', keyword: '#당황', expression: '웃음기가 사라지고 시선을 피함', filename: '당황/웃음:*?' })
await addReaction(pcPage, { emotion: '수줍음', keyword: '#부끄', expression: '고개를 살짝 숙이고 볼이 붉어짐', filename: '' })
await addReaction(pcPage, { emotion: '쑥스러움', keyword: '#부끄', expression: '뒷머리를 긁으며 어색하게 웃음', filename: '수줍음' })

// 시각 요소 → 태그 자동 조립
await pcPage.locator('.rtable tbody tr', { hasText: '#당황' }).click()
await pcPage.locator('.editor').getByRole('button', { name: '+ 시선' }).click()
await pcPage.getByRole('button', { name: '직접 입력 추가' }).click()
const vrow = pcPage.locator('.editor .vrow').first()
await vrow.getByLabel('설명').fill('시선 회피')
await vrow.getByLabel('태그').fill('looking away')
await pcPage.locator('.editor').getByRole('button', { name: '+ 홍조·땀 등 부가 표현' }).click()
await pcPage.getByRole('button', { name: '직접 입력 추가' }).click()
const vrow2 = pcPage.locator('.editor .vrow').nth(1)
await vrow2.getByLabel('설명').fill('식은땀')
await vrow2.getByLabel('태그').fill('sweatdrop')
await saved(pcPage)
const tagsBox = pcPage.locator('.editor .tags textarea')
ok((await tagsBox.inputValue()) === 'looking away, sweatdrop', '시각 요소 태그가 자동 조립됨')
// 직접 수정 후 시각 요소를 바꾸면 덮어쓰지 않음
await tagsBox.fill('looking away, sweatdrop, 직접 넣은 태그')
await saved(pcPage)
await vrow2.getByLabel('태그').fill('sweat')
await saved(pcPage)
ok((await tagsBox.inputValue()) === 'looking away, sweatdrop, 직접 넣은 태그', '직접 수정한 태그는 시각 요소 변경 시 덮어쓰지 않음')
ok(await pcPage.getByText('자동으로 덮어쓰지 않았습니다').isVisible(), '태그 확인 안내 표시')
await pcPage.getByRole('button', { name: '빠진 태그만 뒤에 추가' }).click()
await saved(pcPage)
ok((await tagsBox.inputValue()) === 'looking away, sweatdrop, 직접 넣은 태그, sweat', '빠진 태그만 추가(사용자 수정 보존)')
// 감정명 변경이 다른 값을 덮어쓰지 않음
await typeField(pcPage, '감정·상태명', '당황(변경)')
await saved(pcPage)
ok((await pcPage.locator('.editor').getByLabel('호출 키워드', { exact: true }).inputValue()) === '#당황', '감정명을 바꿔도 키워드 유지')
ok((await tagsBox.inputValue()).includes('직접 넣은 태그'), '감정명을 바꿔도 태그 유지')
ok((await pcPage.locator('.editor').getByLabel('내보내기 파일명', { exact: true }).inputValue()) === '당황/웃음:*?', '감정명을 바꿔도 파일명 유지')
ok(await pcPage.locator('.editor').getByText('금지 문자').isVisible(), '파일명 금지 문자 안내 표시')
ok((await pcPage.locator('.rtable .warn-tag', { hasText: '키워드 중복' }).count()) === 2, '같은 호출 키워드 중복 표시(2개)')
ok((await pcPage.locator('.rtable .warn-tag', { hasText: '파일명 중복' }).count()) === 2, '같은 내보내기 파일명 중복 표시(2개)')
await shot(pcPage, '02-pc-design')

// 새로고침해도 유지
await pcPage.reload()
await pcPage.locator('.rtable').waitFor()
ok((await pcPage.locator('.rtable tbody tr').count()) === 3, '새로고침 후에도 리액션 3개 유지')
ok(await pcPage.locator('.rtable').getByText('당황(변경)').isVisible(), '새로고침 후 수정 내용 유지')

// ───── 2. PC: 이미지 등록·채택 ─────
await pcPage.locator('.rtable tbody tr', { hasText: '#당황' }).click()
await pcPage.locator('.editor input[type=file]').setInputFiles([files[0].path, files[1].path])
await pcPage.locator('.ccard:not(.upload)').nth(1).waitFor({ timeout: 20000 })
await saved(pcPage)
await pcPage.waitForTimeout(500)
ok((await pcPage.locator('.editor .ed-head .badge').innerText()) === '생성됨', '이미지 첫 등록 시 상태가 생성됨')
await pcPage.locator('.ccard').nth(0).getByRole('button', { name: '채택', exact: true }).click()
await saved(pcPage)
ok((await pcPage.locator('.editor .ed-head .badge').innerText()) === '채택', '채택 시 상태가 채택')
await pcPage.locator('.ccard').nth(1).getByRole('button', { name: '채택', exact: true }).click()
await saved(pcPage)
ok((await pcPage.locator('.ccard.adopted').count()) === 1, '채택 변경 후에도 채택은 한 장')
ok((await pcPage.locator('.ccard').nth(1).getAttribute('class')).includes('adopted'), '채택이 두 번째 이미지로 변경')
// 채택 이미지 삭제 → 채택 해제
await pcPage.locator('.ccard.adopted').getByRole('button', { name: '삭제' }).click()
await pcPage.getByLabel(/확인을 위해/).fill('삭제')
await pcPage.locator('.modal').getByRole('button', { name: '삭제' }).click()
await pcPage.waitForTimeout(1500)
await saved(pcPage)
ok((await pcPage.locator('.ccard').count()) === 1, '후보 삭제 반영')
ok((await pcPage.locator('.editor .ed-head .badge').innerText()) === '생성됨', '채택 이미지 삭제 시 채택 해제 → 생성됨')
await pcPage.locator('.ccard').nth(0).getByRole('button', { name: '채택', exact: true }).click()
await saved(pcPage)
// 확대 보기
await pcPage.locator('.ccard .cimg').first().click()
await pcPage.locator('.lb img').waitFor()
ok(await pcPage.locator('.lb img').evaluate((i) => i.complete && i.naturalWidth === 96), '확대 보기에서 원본 이미지 표시')
await pcPage.keyboard.press('Escape')
await shot(pcPage, '03-pc-candidates')

// ───── 3. 모바일(다른 기기): 이어서 작업 ─────
await login(mPage)
await mPage.getByText('하루 리액션').click()
await mPage.locator('.m-rows').waitFor()
await shot(mPage, '04-mobile-list')
await mPage.locator('.m-row', { hasText: '볼이 붉어짐' }).first().click()
await mPage.locator('.editor.mobile').waitFor()
// 태그 입력·복사(복사 전 확인 화면)
await mPage.locator('.editor .tags textarea').fill('blush, head down')
await saved(mPage)
await mPage.getByRole('button', { name: '태그 복사' }).tap()
await mPage.locator('.copy-area').fill('blush, head down, looking down')
await mPage.locator('.modal').getByRole('button', { name: '복사', exact: true }).tap()
await mPage.waitForTimeout(300)
const clip = await mPage.evaluate(() => navigator.clipboard.readText())
ok(clip === 'blush, head down, looking down', '모바일: 복사 전 수정한 최종 태그가 복사됨')
await mPage.locator('.modal').getByRole('button', { name: '닫기' }).tap()
ok((await mPage.locator('.editor .tags textarea').inputValue()) === 'blush, head down', '복사용 임시 수정은 저장하지 않으면 원래 태그 유지')
// 이미지 등록
await mPage.locator('.editor input[type=file]').setInputFiles([files[2].path])
await mPage.locator('.ccard:not(.upload)').first().waitFor({ timeout: 20000 })
await saved(mPage)
ok(await mPage.locator('.ccard img').first().evaluate((i) => i.complete && i.naturalWidth > 0), '모바일: 등록한 이미지 썸네일 표시')
await mPage.locator('.ccard').first().getByRole('button', { name: '채택', exact: true }).tap()
await saved(mPage)
await mPage.locator('.editor').getByLabel('짧은 메모').fill('모바일에서 채택')
await saved(mPage)
await shot(mPage, '05-mobile-focus')
// 다음 리액션으로 이동해 재작업 표시
await mPage.getByRole('button', { name: '다음 리액션' }).tap()
await mPage.locator('.editor.mobile h2', { hasText: '쑥스러움' }).waitFor()
await mPage.locator('.status-row').getByRole('button', { name: '재작업' }).tap()
await saved(mPage)

// ───── 4. PC에서 확인(두 기기 연속성) ─────
await pcPage.reload()
await pcPage.locator('.rtable').waitFor()
const row = pcPage.locator('.rtable tbody tr', { hasText: '볼이 붉어짐' })
ok((await row.locator('.badge').innerText()) === '채택', 'PC: 모바일에서 채택한 상태 반영')
await row.click()
await pcPage.locator('.ccard img').first().waitFor()
ok(await pcPage.locator('.ccard img').first().evaluate((i) => i.complete && i.naturalWidth > 0), 'PC: 모바일에서 올린 이미지 표시')
ok((await pcPage.locator('.editor').getByLabel('작업 메모', { exact: true }).inputValue()) === '모바일에서 채택', 'PC: 모바일 메모 반영')
ok((await pcPage.locator('.rtable tbody tr', { hasText: '뒷머리' }).locator('.badge').innerText()) === '재작업', 'PC: 모바일 재작업 표시 반영')

// ───── 5. 충돌 방지 ─────
// PC와 모바일이 같은 리액션을 연 상태에서 모바일이 먼저 저장 → PC의 오래된 화면 저장은 충돌로 멈춤
await mPage.getByRole('button', { name: '← 목록' }).tap()
await mPage.locator('.m-row', { hasText: '볼이 붉어짐' }).first().tap()
await mPage.locator('.editor').getByLabel('짧은 메모').fill('모바일 최신 메모')
await saved(mPage)
await pcPage.locator('.editor').getByLabel('작업 메모', { exact: true }).fill('PC 오래된 화면 메모')
await pcPage.getByText('수정 충돌 확인').waitFor({ timeout: 15000 })
ok(true, '오래된 화면의 저장은 덮어쓰지 않고 충돌 확인 창 표시')
await shot(pcPage, '06-pc-conflict')
await pcPage.getByRole('button', { name: '모두 다른 기기 값' }).click()
await saved(pcPage)
const { data: memoRow } = await admin.from('reactions').select('memo').eq('owner_id', OWNER).eq('emotion', '수줍음').single()
ok(memoRow.memo === '모바일 최신 메모', '충돌 해결 후 선택한 값(다른 기기 값)이 유지')

// ───── 6. 목록 복제 ─────
await pcPage.getByRole('button', { name: '리액션 작업실' }).click()
await pcPage.getByRole('button', { name: '+ 새 프로젝트' }).click()
await pcPage.getByLabel('프로젝트명').fill('하루 2차')
await pcPage.getByLabel('캐릭터명').fill('하루')
await pcPage.getByLabel('리액션 목록 복제(선택)').selectOption({ label: '하루 리액션 · 하루' })
await pcPage.getByRole('button', { name: '만들기', exact: true }).click()
await pcPage.locator('.rtable').waitFor()
ok((await pcPage.locator('.rtable tbody tr').count()) === 3, '목록 복제: 리액션 3개 복사')
ok((await pcPage.locator('.rtable .badge', { hasText: '미작업' }).count()) === 3, '목록 복제: 진행 상태 제외(모두 미작업)')
ok((await pcPage.locator('.rtable td.c-n', { hasText: '0' }).count()) === 3, '목록 복제: 이미지 제외')
await pcPage.locator('.rtable tbody tr', { hasText: '볼이 붉어짐' }).click()
await typeField(pcPage, '감정·상태명', '수줍음-복제본수정')
await typeField(pcPage, '캐릭터별 표현 설명', '복제본에서만 바꾼 설명')
await saved(pcPage)
const { data: orig } = await admin.from('reactions').select('emotion,expression,project_id').eq('owner_id', OWNER).eq('emotion', '수줍음')
ok(orig.length === 1 && orig[0].expression === '고개를 살짝 숙이고 볼이 붉어짐', '복제본 수정이 원본 프로젝트에 영향 없음')

// ───── 7. 내보내기 ─────
await pcPage.goto(projectUrl)
await pcPage.locator('.rtable').waitFor()
await pcPage.getByRole('button', { name: '채택 이미지 내보내기' }).click()
await pcPage.locator('.ptable').waitFor()
const names = await pcPage.locator('.ptable code').allInnerTexts()
ok(names.includes('당황_웃음___.png'), `금지 문자 처리된 파일명 미리보기 (${names.join(' | ')})`)
ok(names.includes('수줍음.png'), '파일명이 비면 감정명 사용')
await shot(pcPage, '07-pc-export')
const [dl] = await Promise.all([pcPage.waitForEvent('download'), pcPage.getByRole('button', { name: /ZIP 내보내기/ }).click()])
const zipPath = `${OUT}/export.zip`
await dl.saveAs(zipPath)
const zipped = unzipSync(new Uint8Array(readFileSync(zipPath)))
const zNames = Object.keys(zipped).sort()
ok(zNames.length === 2, `ZIP에 채택 이미지 2개 (${zNames.join(', ')})`)
ok(zNames.includes('수줍음.png') && zNames.includes('당황_웃음___.png'), 'ZIP 안 한국어 파일명 유지')
ok(sha(zipped['수줍음.png']) === sha(files[2].bytes), '내보낸 이미지(모바일 업로드분)의 바이트가 원본과 동일')
const pcFile = files.slice(0, 2).find((f) => sha(f.bytes) === sha(zipped['당황_웃음___.png']))
ok(!!pcFile, '내보낸 이미지(PC 업로드분)의 바이트가 원본 파일과 동일')
ok(readPngText(zipped['수줍음.png']).Comment?.includes('test 3'), '내보낸 이미지의 PNG 메타데이터 유지')
await pcPage.keyboard.press('Escape')

// 중복 파일명: 쑥스러움에도 이미지 채택 → 파일명 "수줍음" 겹침
await pcPage.locator('.rtable tbody tr', { hasText: '뒷머리' }).click()
await pcPage.locator('.editor input[type=file]').setInputFiles([files[3].path])
await pcPage.locator('.ccard:not(.upload)').first().waitFor({ timeout: 20000 })
await pcPage.locator('.ccard').first().getByRole('button', { name: '채택', exact: true }).click()
await saved(pcPage)
await pcPage.getByRole('button', { name: '채택 이미지 내보내기' }).click()
await pcPage.locator('.ptable').waitFor()
const names2 = await pcPage.locator('.ptable code').allInnerTexts()
ok(names2.includes('수줍음.png') && names2.includes('수줍음_2.png'), `중복 파일명은 번호를 붙여 덮어쓰기 방지 (${names2.join(' | ')})`)
const [dl2] = await Promise.all([pcPage.waitForEvent('download'), pcPage.getByRole('button', { name: /ZIP 내보내기/ }).click()])
await dl2.saveAs(`${OUT}/export2.zip`)
const z2 = unzipSync(new Uint8Array(readFileSync(`${OUT}/export2.zip`)))
ok(Object.keys(z2).length === 3 && sha(z2['수줍음_2.png']) === sha(files[3].bytes), '중복 이름 파일도 모두 내보내짐(덮어쓰기 없음)')

// 선택 내보내기
await pcPage.locator('.rtable tbody tr', { hasText: '뒷머리' }).locator('input[type=checkbox]').check()
await pcPage.getByRole('button', { name: '선택 내보내기' }).click()
await pcPage.locator('.ptable').waitFor()
ok((await pcPage.locator('.ptable tbody tr').count()) === 1, '선택한 리액션만 내보내기 대상')
await pcPage.keyboard.press('Escape')
await pcPage.getByRole('button', { name: '선택 해제' }).click()

// ───── 8. 백업·복원 ─────
await pcPage.getByRole('button', { name: '백업', exact: true }).click()
const [bdl] = await Promise.all([pcPage.waitForEvent('download'), pcPage.getByRole('button', { name: '백업 ZIP 만들기' }).click()])
const backupPath = `${OUT}/backup.zip`
await bdl.saveAs(backupPath)
const bz = unzipSync(new Uint8Array(readFileSync(backupPath)))
const manifest = JSON.parse(new TextDecoder().decode(bz['backup.json']))
ok(manifest.format === 'nai-reaction-studio-backup' && manifest.formatVersion === 1, '백업 형식·버전 기록')
ok(Object.keys(bz).filter((k) => k.startsWith('images/')).length === 3, '백업에 후보 이미지 3장 포함')

await pcPage.getByRole('button', { name: '리액션 작업실' }).click()
const projCountBefore = (await admin.from('projects').select('id').eq('owner_id', OWNER)).data.length
// 잘못된 백업: 이미지 바이트를 바꾼 ZIP → 거부, 아무것도 만들지 않음
const bad = { ...bz }
const imgKey = Object.keys(bz).find((k) => k.startsWith('images/'))
bad[imgKey] = new Uint8Array([...bz[imgKey].slice(0, -4), 0, 0, 0, 0])
writeFileSync(`${OUT}/bad-backup.zip`, zipSync(bad))
writeFileSync(`${OUT}/not-backup.zip`, zipSync({ 'hello.txt': strToU8('hi') }))
await pcPage.getByRole('button', { name: '백업에서 복원' }).click()
await pcPage.locator('.modal input[type=file]').setInputFiles(`${OUT}/bad-backup.zip`)
await pcPage.locator('.modal .error').waitFor()
ok((await pcPage.locator('.modal .error').innerText()).includes('손상'), '손상된 백업은 검사 단계에서 거부')
await pcPage.locator('.modal input[type=file]').setInputFiles(`${OUT}/not-backup.zip`)
await pcPage.locator('.modal .error', { hasText: '백업 파일이 아닙니다' }).waitFor()
ok(true, '다른 ZIP은 거부')
ok((await admin.from('projects').select('id').eq('owner_id', OWNER)).data.length === projCountBefore, '잘못된 백업을 불러와도 프로젝트가 생기거나 바뀌지 않음')
await pcPage.locator('.modal input[type=file]').setInputFiles(backupPath)
await pcPage.getByText('리액션 3개 · 이미지 3장').waitFor()
await pcPage.getByRole('button', { name: '새 프로젝트로 복원' }).click()
await pcPage.locator('.rtable').waitFor({ timeout: 30000 })
await pcPage.waitForTimeout(800)
const restoredRows = await pcPage.locator('.rtable tbody tr').count()
ok(restoredRows === 3, '복원: 리액션 3개')
const badges = await pcPage.locator('.rtable .badge').allInnerTexts()
ok(badges.filter((b) => b === '채택').length === 3, `복원: 채택 상태 유지 (${badges.join(',')})`)
await pcPage.locator('.rtable tbody tr', { hasText: '#당황' }).click()
ok((await pcPage.locator('.editor .tags textarea').inputValue()) === 'looking away, sweatdrop, 직접 넣은 태그, sweat', '복원: 태그 유지')
ok((await pcPage.locator('.editor .vrow').count()) === 2, '복원: 시각 요소 유지')
await pcPage.locator('.ccard.adopted').waitFor()
ok((await pcPage.locator('.ccard').count()) === 1, '복원: 후보 이미지 유지')
const { data: restoredC } = await admin.from('candidates').select('sha256,original_name').eq('owner_id', OWNER).order('created_at', { ascending: false }).limit(4)
ok(restoredC.some((c) => c.sha256 === sha(pcFile.bytes) && c.original_name === pcFile.path.split('/').pop()), '복원: 원본 해시·원본 파일명 유지')
ok(projCountBefore + 1 === (await admin.from('projects').select('id').eq('owner_id', OWNER)).data.length, '복원은 새 프로젝트로 추가(기존 프로젝트 유지)')
await shot(pcPage, '08-pc-restored')

// ───── 9. 다른 사용자 ─────
const other = await browser.newContext({ viewport: { width: 1200, height: 800 } })
const oPage = await other.newPage()
await login(oPage, EMAIL_B)
ok(await oPage.getByText('처음 오셨네요').waitFor({ timeout: 8000 }).then(() => true, () => false), '다른 사용자에게는 소유자의 프로젝트가 보이지 않음')
await oPage.goto(projectUrl)
await oPage.getByText('프로젝트를 찾을 수 없습니다').waitFor()
ok(true, '다른 사용자가 소유자의 프로젝트 주소를 열어도 내용이 보이지 않음')

// ───── 10. 업로드 실패 → 재시도 ─────
await pcPage.goto(projectUrl)
await pcPage.locator('.rtable').waitFor()
await pcPage.locator('.rtable tbody tr', { hasText: '뒷머리' }).click()
await pc.route('**/storage/v1/object/**', (route) => (route.request().method() === 'POST' ? route.abort('failed') : route.continue()))
await pcPage.locator('.editor input[type=file]').setInputFiles([files[1].path])
await pcPage.locator('.ccard.upload.up-failed').waitFor({ timeout: 20000 })
ok(await pcPage.locator('.sync.bad').isVisible(), '업로드 실패 시 상단에 실패 표시(완료로 표시하지 않음)')
await shot(pcPage, '09-pc-upload-failed')
await pc.unroute('**/storage/v1/object/**')
await pcPage.locator('.ccard.upload').getByRole('button', { name: '다시 시도' }).click()
await pcPage.locator('.ccard:not(.upload)').nth(1).waitFor({ timeout: 20000 })
ok((await pcPage.locator('.ccard.upload').count()) === 0, '재시도 후 업로드 완료')

// 모바일 화면 스크린샷 하나 더
await mPage.reload()
await mPage.locator('.editor.mobile').waitFor()
await shot(mPage, '10-mobile-after')

await browser.close()
console.log(failed ? `\n${failed} FAILED` : '\nALL BROWSER TESTS PASSED')
process.exit(failed ? 1 : 0)

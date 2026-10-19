// Supabase의 API 게이트웨이(Kong)를 흉내 내는 작은 프록시: /auth/v1, /rest/v1, /storage/v1 를 각 서비스로 전달
import http from 'node:http'
const routes = [
  ['/auth/v1', 9999],
  ['/rest/v1', 3000],
  ['/storage/v1', 5000],
]
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
  'access-control-expose-headers': '*',
}
http
  .createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      return res.end()
    }
    const r = routes.find(([p]) => req.url.startsWith(p + '/') || req.url === p || req.url.startsWith(p + '?'))
    if (!r) {
      res.writeHead(404, cors)
      return res.end('no route')
    }
    const path = req.url.slice(r[0].length) || '/'
    const headers = { ...req.headers, host: `127.0.0.1:${r[1]}` }
    // Kong처럼 apikey만 있고 Authorization이 없으면 apikey를 Bearer로 사용
    if (!headers.authorization && headers.apikey) headers.authorization = `Bearer ${headers.apikey}`
    const up = http.request({ host: '127.0.0.1', port: r[1], path, method: req.method, headers }, (ur) => {
      const h = { ...ur.headers, ...cors }
      res.writeHead(ur.statusCode, h)
      ur.pipe(res)
    })
    up.on('error', (e) => {
      res.writeHead(502, cors)
      res.end(String(e))
    })
    req.pipe(up)
  })
  .listen(54321, () => console.log('proxy on 54321'))

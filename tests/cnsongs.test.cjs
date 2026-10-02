const assert = require('node:assert/strict')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { mkdtemp, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { before, after, test } = require('node:test')
const initSqlJs = require('sql.js')
const { unstable_dev, unstable_readConfig } = require('wrangler')

let worker
let server
let SQL
let configDirectory
let mode = 'normal'
let upstreamHits = []

const activeSong = {
  id: 2, open_day: '7/25/2023', song_name: '当前歌曲', song_name_jp: 'Current',
  level_1: 3, level_2: 4, level_3: 5, level_4: 8, level_5: '-',
  subtitle: '', family: false, type: '流行音乐', sort: 10,
  types: [{ type: '流行音乐', sort: 10 }],
  tag: 'New', future_field: { preserve: [true, null, '中文'] },
}
const deletedSong = {
  id: 1, song_name: '已删除歌曲', song_name_jp: 'Deleted',
  level_5: 10, family: '○', subtitle: null, type: '动漫音乐', sort: 20,
}
const deletedTypes = [{ type: '动漫音乐', sort: 20 }, { type: '儿童音乐', sort: 30 }]

function databaseBytes(deleted = true) {
  const database = new SQL.Database()
  try {
    database.run(`CREATE TABLE songs (
      id INTEGER PRIMARY KEY, source_json TEXT, types TEXT, is_deleted INTEGER
    )`)
    // Deliberately insert out of order to check stable id ordering.
    database.run('INSERT INTO songs VALUES (?, ?, ?, ?)', [
      2, JSON.stringify(activeSong), JSON.stringify(activeSong.types), 0,
    ])
    database.run('INSERT INTO songs VALUES (?, ?, ?, ?)', [
      1, JSON.stringify(deletedSong), JSON.stringify(deletedTypes), Number(deleted),
    ])
    return Buffer.from(database.export())
  } finally {
    database.close()
  }
}

before(async () => {
  SQL = await initSqlJs()
  server = createServer((request, response) => {
    upstreamHits.push(request.url)
    if (request.url === '/other.json') {
      response.setHeader('Content-Type', 'text/plain')
      response.end(JSON.stringify({ untouched: true }))
      return
    }
    if (mode === 'unavailable' || (mode === 'fallback' && request.url === '/primary.sqlite3')) {
      response.writeHead(404)
      response.end('Not found')
      return
    }
    if (mode === 'broken' || (mode === 'corrupt-primary' && request.url === '/primary.sqlite3')) {
      response.end('<html>not SQLite</html>')
      return
    }
    if (mode === 'wrong-schema') {
      const database = new SQL.Database()
      database.run('CREATE TABLE unrelated (id INTEGER)')
      response.end(Buffer.from(database.export()))
      database.close()
      return
    }
    response.setHeader('Content-Type', 'application/octet-stream')
    response.end(databaseBytes(mode !== 'restored'))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const upstream = `http://127.0.0.1:${server.address().port}`
  const projectConfig = unstable_readConfig({ config: resolve('wrangler.toml') })
  configDirectory = await mkdtemp(join(tmpdir(), 'cloudn-test-'))
  const config = join(configDirectory, 'wrangler.json')
  await writeFile(config, JSON.stringify({
    name: 'cloudn-test',
    main: resolve('src/index.js'),
    compatibility_date: projectConfig.compatibility_date,
    define: projectConfig.define,
    vars: {
      FILE_MAP: {
        '/api/cnsongs': [`${upstream}/primary.sqlite3`, `${upstream}/mirror.sqlite3`],
        '/api/other': `${upstream}/other.json`,
      },
      PREVIEW_IMAGE_BASES: [],
    },
  }))
  worker = await unstable_dev(resolve('src/index.js'), {
    config,
    local: true,
    port: 0,
    inspectorPort: 0,
    logLevel: 'error',
    persist: false,
    experimental: { disableExperimentalWarning: true },
  })
}, { timeout: 30000 })

after(async () => {
  await worker?.stop()
  if (server) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  if (configDirectory) await rm(configDirectory, { recursive: true, force: true })
})

test('returns every original field and both active and deleted songs', async () => {
  mode = 'normal'
  const response = await worker.fetch('/api/cnsongs?test=fields')
  assert.equal(response.status, 200)
  assert.match(response.headers.get('Content-Type'), /application\/json/)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*')
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=3600')
  assert.deepEqual(await response.json(), [
    { ...deletedSong, types: deletedTypes, is_deleted: true },
    { ...activeSong, is_deleted: false },
  ])
})

test('falls back to the SQLite mirror after a missing primary', async () => {
  mode = 'fallback'
  upstreamHits = []
  const response = await worker.fetch('/api/cnsongs?test=fallback')
  assert.equal(response.status, 200)
  assert.equal((await response.json()).length, 2)
  assert.deepEqual(upstreamHits, ['/primary.sqlite3', '/mirror.sqlite3'])
})

test('falls back after an invalid primary response with HTTP 200', async () => {
  mode = 'corrupt-primary'
  upstreamHits = []
  const response = await worker.fetch('/api/cnsongs?test=corrupt-primary')
  assert.equal(response.status, 200)
  assert.equal((await response.json())[0].is_deleted, true)
  assert.deepEqual(upstreamHits, ['/primary.sqlite3', '/mirror.sqlite3'])
})

test('returns boolean false for a restored song', async () => {
  mode = 'restored'
  const response = await worker.fetch('/api/cnsongs?test=restored')
  const songs = await response.json()
  assert.equal(songs.find(song => song.id === 1).is_deleted, false)
})

test('supports HEAD and CORS preflight without a response body', async () => {
  mode = 'normal'
  for (const method of ['HEAD', 'OPTIONS']) {
    const response = await worker.fetch('/api/cnsongs?test=methods', { method })
    assert.equal(response.status, method === 'HEAD' ? 200 : 204)
    assert.equal(await response.text(), '')
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*')
  }
})

test('does not accept writes to the read-only catalog', async () => {
  const response = await worker.fetch('/api/cnsongs', { method: 'POST' })
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('Allow'), 'GET, HEAD, OPTIONS')
})

test('all upstream failures return an uncached JSON error', async () => {
  for (mode of ['unavailable', 'broken', 'wrong-schema']) {
    const response = await worker.fetch(`/api/cnsongs?test=${mode}`)
    assert.equal(response.status, 502)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*')
    assert.deepEqual(await response.json(), { error: 'Failed to fetch songs database' })
  }
})

test('serves cached JSON when the upstream later becomes unavailable', async () => {
  mode = 'normal'
  const url = '/api/cnsongs?test=cache'
  const first = await worker.fetch(url)
  assert.equal(first.status, 200)
  const songs = await first.json()
  // Allow the Worker's background cache.put() to complete.
  await new Promise(resolve => setTimeout(resolve, 100))
  mode = 'unavailable'
  upstreamHits = []
  const cached = await worker.fetch(url)
  assert.equal(cached.status, 200)
  assert.deepEqual(await cached.json(), songs)
  assert.deepEqual(upstreamHits, [])
})

test('other JSON routes still proxy their existing response', async () => {
  const response = await worker.fetch('/api/other')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { untouched: true })
  assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8')
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*')
})

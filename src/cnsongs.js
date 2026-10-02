import initSqlJs from 'sql.js/dist/sql-wasm-browser.js'
import sqliteWasm from 'sql.js/dist/sql-wasm-browser.wasm'

// Workers require the bundled, precompiled Wasm module instead of compiling
// bytes fetched at runtime. Reuse the SQLite engine across requests.
const sqlite = initSqlJs({
  instantiateWasm(imports, receiveInstance) {
    const instance = new WebAssembly.Instance(sqliteWasm, imports)
    receiveInstance(instance, sqliteWasm)
    return instance.exports
  },
})

async function readSongsDatabase(bytes) {
  const SQL = await sqlite
  const database = new SQL.Database(new Uint8Array(bytes))
  try {
    const statement = database.prepare(
      'SELECT id, source_json, types, is_deleted FROM songs ORDER BY id'
    )
    try {
      const songs = []
      while (statement.step()) {
        const row = statement.getAsObject()
        const song = JSON.parse(row.source_json)
        const types = JSON.parse(row.types)
        if (!song || song.id !== row.id || !Array.isArray(types) ||
            (row.is_deleted !== 0 && row.is_deleted !== 1)) {
          throw new Error('Invalid song archive record')
        }
        // source_json keeps every original field, including future optional
        // fields. types also includes categories merged from older snapshots.
        songs.push({ ...song, types, is_deleted: row.is_deleted === 1 })
      }
      return songs
    } finally {
      statement.free()
    }
  } finally {
    database.close()
  }
}

export async function handleCnSongs(request, sources, context, corsHeaders) {
  const headers = {
    ...corsHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
  }
  const errorResponse = (message, status) => new Response(
    request.method === 'HEAD' ? null : JSON.stringify({ error: message }),
    { status, headers: { ...headers, 'Cache-Control': 'no-store' } }
  )
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const response = errorResponse('Method not allowed', 405)
    response.headers.set('Allow', 'GET, HEAD, OPTIONS')
    return response
  }
  if (sources.length === 0) {
    return errorResponse('Songs database not configured', 500)
  }

  // Cache the converted JSON as well as the upstream SQLite file. Version the
  // key so cached responses from the former JSON route cannot omit deleted songs.
  const cacheUrl = new URL(request.url)
  cacheUrl.searchParams.set('__cloudn_cnsongs_format', 'sqlite-v1')
  const cacheKey = new Request(cacheUrl, { method: 'GET' })
  const cache = caches.default
  const cached = await cache.match(cacheKey)
  if (cached) {
    return request.method === 'HEAD'
      ? new Response(null, { status: cached.status, headers: cached.headers })
      : cached
  }

  for (const source of sources) {
    let songs
    try {
      const upstream = await fetch(source, {
        cf: { cacheEverything: true, cacheTtl: 3600 },
      })
      if (upstream.status !== 200) {
        await upstream.body?.cancel()
        continue
      }
      songs = await readSongsDatabase(await upstream.arrayBuffer())
    } catch (error) {
      console.warn('Unable to read song database:', error.message)
      // A mirror may return HTML, an old JSON file, or invalid SQLite with 200.
      // Try the next database source in those cases too.
      continue
    }

    const response = new Response(JSON.stringify(songs), { headers })
    context.waitUntil(cache.put(cacheKey, response.clone()))
    return request.method === 'HEAD'
      ? new Response(null, { headers })
      : response
  }

  return errorResponse('Failed to fetch songs database', 502)
}

import { env } from "cloudflare:workers";
import { handleCnSongs } from './cnsongs.js'

const FILE_MAP = env.FILE_MAP
const PREVIEW_IMAGE_BASES = env.PREVIEW_IMAGE_BASES

function normalizeSources(configuredSources) {
  if (Array.isArray(configuredSources)) {
    return configuredSources.filter(source => typeof source === 'string' && source.length > 0)
  }

  return typeof configuredSources === 'string' && configuredSources.length > 0
    ? [configuredSources]
    : []
}

async function fetchFirstAvailable(configuredSources) {
  for (const sourceUrl of normalizeSources(configuredSources)) {
    try {
      const response = await fetch(sourceUrl, {
        cf: {
          cacheEverything: true,
          cacheTtl: 3600,
        },
      })

      if (response.status === 200) {
        return { response, sourceUrl }
      }

      await response.body?.cancel()
    } catch {
      // 当前来源不可用时继续尝试下一个来源。
    }
  }

  return null
}

// difficulty 数字到字段名的映射
const DIFFICULTY_MAP = {
  '1': 'easy',
  '2': 'normal',
  '3': 'hard',
  '4': 'oni',
  '5': 'ura'
}

// 处理 /api/preview/{id} 路由 - 返回指定 ID 的预览数据
async function handlePreviewById(id) {
  try {
    // 从 /api/previews 获取完整的预览数据库
    const previewSources = FILE_MAP['/api/previews']
    if (normalizeSources(previewSources).length === 0) {
      return new Response("Previews database not configured", { status: 500 })
    }

    const upstream = await fetchFirstAvailable(previewSources)
    if (!upstream) {
      return new Response("Failed to fetch previews database", { status: 500 })
    }

    const previewsJson = await upstream.response.json()

    // 从 JSON 中获取指定 ID 的数据
    const previewData = previewsJson[id]

    if (!previewData) {
      return new Response(`Preview data for ID ${id} not found`, { status: 404 })
    }

    // 返回 JSON 响应
    const headers = new Headers()
    applyCors(headers)
    headers.set("Content-Type", "application/json")
    headers.set("Cache-Control", "public, max-age=3600")

    return new Response(JSON.stringify(previewData), {
      status: 200,
      headers,
    })
  } catch (error) {
    return new Response(`Error: ${error.message}`, { status: 500 })
  }
}

// 处理 /api/preview/{id}/{filename} 路由 - 从 GitHub 获取图片
async function handlePreviewImage(id, filename) {
  try {
    const imageSources = normalizeSources(PREVIEW_IMAGE_BASES)
      .map(baseUrl => `${baseUrl.replace(/\/$/, '')}/${id}/${filename}`)
    const result = await fetchFirstAvailable(imageSources)

    if (!result) {
      return new Response(`Image not found: ${id}/${filename}`, { status: 404 })
    }
    const { response: upstream } = result

    // 复制响应头并注入 CORS
    const headers = new Headers(upstream.headers)
    applyCors(headers)
    headers.set("Cache-Control", "public, max-age=3600")

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    })
  } catch (error) {
    return new Response(`Error: ${error.message}`, { status: 500 })
  }
}

// 处理 FILE_MAP 映射路由
async function handleFileMap(pathname) {
  const configuredSources = FILE_MAP[pathname]
  if (!configuredSources) {
    // 如果没有匹配的 CDN 路由，返回一个 HTML 页面，列出所有可用的接口
    const available = Object.keys(FILE_MAP || {})
    const listItems = available.map(p => `<li><a href="${p}">${p}</a></li>`).join('')
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Available APIs</title>
    <style>body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:32px}a{color:#0366d6}</style>
  </head>
  <body>
    <h1>Available APIs</h1>
    <p>可用的 CDN 路由（点击访问）：</p>
    <ul>
      ${listItems}
    </ul>
    <h2>Preview Routes</h2>
    <ul>
      <li><code>/api/preview/{id}</code> — 获取指定 ID 的预览数据</li>
      <li><code>/api/preview/{id}/{filename}</code> — 获取指定预览图片</li>
    </ul>
  </body>
</html>`

    const headers = new Headers()
    applyCors(headers)
    headers.set("Content-Type", "text/html; charset=utf-8")
    headers.set("Cache-Control", "no-cache")

    return new Response(html, { status: 200, headers })
  }

  const result = await fetchFirstAvailable(configuredSources)
  if (!result) {
    return new Response("Upstream Not Found", { status: 404 })
  }
  const { response: upstream, sourceUrl } = result

  // 复制响应头并注入 CORS
  const headers = new Headers(upstream.headers)
  applyCors(headers)

  // 修正 GitHub Raw 对 JSON 文件错误返回 text/plain 的问题
  if (sourceUrl.endsWith('.json')) {
    headers.set("Content-Type", "application/json; charset=utf-8")
  }

  // 强制 CDN 可缓存
  headers.set("Cache-Control", "public, max-age=3600")

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  })
}

export default {
  async fetch(request, _env, context) {
    const url = new URL(request.url)
    const pathname = url.pathname

    // 处理 CORS 预检请求
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      })
    }

    if (pathname === '/api/cnsongs') {
      return handleCnSongs(
        request,
        normalizeSources(FILE_MAP[pathname]),
        context,
        corsHeaders(),
      )
    }

    // 检查是否是 /api/preview/{id}/{filename} 路由（需要在 /api/preview/{id} 之前检查）
    const previewImageMatch = pathname.match(/^\/api\/preview\/([^\/]+)\/([^\/]+)\/?$/)
    if (previewImageMatch) {
      const [, id, filename] = previewImageMatch
      return await handlePreviewImage(id, filename)
    }

    // 检查是否是 /api/preview/{id} 路由
    const previewByIdMatch = pathname.match(/^\/api\/preview\/([^\/]+)\/?$/)
    if (previewByIdMatch) {
      const [, id] = previewByIdMatch
      return await handlePreviewById(id)
    }

    return await handleFileMap(pathname)
  },
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
  }
}

function applyCors(headers) {
  headers.set("Access-Control-Allow-Origin", "*")
  headers.set("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS")
  headers.set("Access-Control-Allow-Headers", "*")
}

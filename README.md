# ClouDN

将固定的 `/api/*` 路径映射到 GitHub 仓库中的数据文件，
并通过 Cloudflare Worker 提供 CDN 缓存和 CORS 支持。

## API

- [/api/cnsongs](https://cdn.ourtaiko.org/api/cnsongs)
- [/api/fumendb_constants](https://cdn.ourtaiko.org/api/fumendb_constants)
- [/api/gugu_constants](https://cdn.ourtaiko.org/api/gugu_constants)
- [/api/previews](https://cdn.ourtaiko.org/api/previews)
- [/api/preview/${id}](https://cdn.ourtaiko.org/api/preview/495)
- [/api/preview/${id}/${filename}](https://cdn.ourtaiko.org/api/preview/495/4.jpg)

### 国服曲库 `/api/cnsongs`

此路由读取 `taiko-song-database-cn` 仓库的 `songs.sqlite3`，返回按 `id`
升序排列的 JSON 数组，包含当前歌曲和历史中已删除的歌曲。

- 从数据库的 `source_json` 恢复原有歌曲字段，包括可选字段及其原始值。
- `types` 使用数据库中合并后的分类数组，补全早期重复分类记录。
- 每首歌曲额外返回布尔字段 `is_deleted`：`true` 表示当前曲库中已不存在，
  `false` 表示仍然存在；歌曲重新上架、数据库更新且缓存刷新后会返回 `false`。
- 不返回 `source_json`、`last_seen_commit` 等内部归档字段。
- 支持 `GET`、`HEAD` 和 `OPTIONS`，保留 CORS 和一小时缓存。
- 按 `FILE_MAP` 中的顺序尝试 SQLite 来源；下载失败或文件无效时切换备用源。
  所有来源均失败时返回不缓存的 `502` JSON 错误。

Worker 使用随代码打包的 sql.js WebAssembly 读取远端 SQLite，无需 D1 或其他
数据库服务。`wrangler.toml` 中的 `self.location.href` 构建替换用于适配 sql.js
对浏览器 Worker 环境的检测，Wasm 模块不会在运行时从远端加载。

## 验证

```bash
npm ci
npm test
npx wrangler deploy --dry-run
```

测试在本地 Worker 运行时中读取真实 SQLite 格式的测试数据，覆盖原始字段、
删除和重新上架、备用源、错误响应、缓存、HEAD/CORS 以及其他 JSON 路由。

## 部署

```bash
npm install
wrangler login
npm run deploy
```

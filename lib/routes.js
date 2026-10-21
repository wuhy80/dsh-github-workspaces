/**
 * /api/dsh-github-workspaces 路由族。
 *
 * 每条路由都过一道 loopback 门禁：这些端点会跑 git、写设置文件，LAN 暴露的
 * dsh web 部署不应该把它们敞开（与 dsh-ssh 同一策略）。
 *
 * POST /open   虽由面板点击触发，但它是「登记工作区」的应用操作，与
 *              github_workspace 工具的 open 动作共用 WorkspaceOpener.open；
 * POST /commit 与 /pull 的提交推送是改变远端状态的动作，只由面板调用，
 *              agent 工具不提供对应动作。
 */

import fs from 'node:fs'
import { run } from './proc.js'

/** 路由前缀。 */
const BASE = '/api/dsh-github-workspaces'

/** 端点表（面板与工具共享同一份形状）。 */
export const ENDPOINTS = {
  state: `${BASE}/state`,
  settings: `${BASE}/settings`,
  repos: `${BASE}/repos`,
  open: `${BASE}/open`,
  status: `${BASE}/status`,
  pull: `${BASE}/pull`,
  commit: `${BASE}/commit`,
  diagnose: `${BASE}/diagnose`,
  forget: `${BASE}/forget`,
  reveal: `${BASE}/reveal`,
}

/** 请求是否来自本机回环。 */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 写 JSON 响应。 */
function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** 读 JSON 请求体（上限 2 MB，超了直接丢弃）。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) {
        finish(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return finish({})
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(null)
      }
    })
    req.on('error', () => finish(null))
  })
}

/** 一条路由：门禁 + 方法校验 + 统一错误包装。 */
function route(path, method, handler) {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!isLoopback(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== method) {
        writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
        return
      }
      try {
        const body = method === 'POST' ? await readJsonBody(req) : {}
        if (body === null) {
          writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
          return
        }
        const value = await handler(body, req)
        writeJson(res, 200, value === undefined ? { ok: true } : value)
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}

/**
 * 一条 NDJSON 流式路由。
 *
 * 克隆/拉取可能要跑几分钟，一个阻塞响应会让面板看起来卡死；这里先发
 * `stage` / `progress` 帧，最后发一帧 `result`。客户端断开或点「取消」时，
 * 响应关闭会中止 AbortController，把 git 子进程直接杀掉。
 *
 * @param {string} path - 精确路由路径。
 * @param {(body: any, ctx: {emit: Function, signal: AbortSignal}) => Promise<any>} handler
 */
function streamRoute(path, handler) {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!isLoopback(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
        return
      }
      const body = await readJsonBody(req)
      if (body === null) {
        writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
        return
      }
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
      })
      const emit = (frame) => {
        try {
          res.write(`${JSON.stringify(frame)}\n`)
        } catch {
          /* 客户端已断开 */
        }
      }
      const controller = new AbortController()
      const onClose = () => {
        if (!res.writableEnded) controller.abort()
      }
      res.on('close', onClose)
      try {
        const value = await handler(body, { emit, signal: controller.signal })
        emit({ type: 'result', ok: value === undefined || value.ok !== false, payload: value ?? { ok: true } })
      } catch (error) {
        emit({
          type: 'result',
          ok: false,
          payload: { ok: false, error: error instanceof Error ? error.message : String(error) },
        })
      } finally {
        if (typeof res.off === 'function') res.off('close', onClose)
        if (!res.writableEnded) res.end()
      }
    },
  }
}

/** 运行环境信息（面板首屏的「体检条」）。 */
async function environment(git, store) {
  return {
    git: await git.version(),
    platform: process.platform,
    node: process.version,
    cloneRoot: store.cloneRoot(),
    settingsFile: store.file,
    mirrorCandidates: store.snapshot().mirrorCandidates,
  }
}

/**
 * 构造全部路由。
 * @param {{store: any, git: any, api: any, opener: any}} deps
 * @returns {Array<{kind: 'exact', path: string, handler: Function}>}
 */
export function makeRoutes(deps) {
  const { store, git, api, opener } = deps

  return [
    route(ENDPOINTS.state, 'GET', async () => ({
      ok: true,
      settings: store.snapshot(),
      env: await environment(git, store),
      workspaces: await opener.list(),
    })),

    route(ENDPOINTS.settings, 'POST', async (body) => ({
      ok: true,
      settings: store.update(body),
    })),

    route(ENDPOINTS.repos, 'POST', async (body) => {
      const repos = await api.listRepos()
      const query = typeof body.query === 'string' ? body.query.trim().toLowerCase() : ''
      const filtered = query === ''
        ? repos
        : repos.filter((repo) =>
          repo.fullName.toLowerCase().includes(query) ||
          (typeof repo.description === 'string' && repo.description.toLowerCase().includes(query)),
        )
      return { ok: true, repos: filtered, total: repos.length }
    }),

    streamRoute(ENDPOINTS.open, async (body, { emit, signal }) => opener.open({
      ...body,
      signal,
      onStage: (stage) => emit({ type: 'stage', ...stage }),
      onProgress: (progress) => emit({ type: 'progress', ...progress }),
    })),

    route(ENDPOINTS.status, 'POST', async (body) => opener.status(body.repo)),

    streamRoute(ENDPOINTS.pull, async (body, { emit, signal }) => opener.pull(body.repo, {
      signal,
      mode: body.mode,
      onStage: (stage) => emit({ type: 'stage', ...stage }),
    })),

    route(ENDPOINTS.commit, 'POST', async (body) => opener.commit(body.repo, body.message)),

    route(ENDPOINTS.diagnose, 'POST', async () => {
      const result = await git.diagnose()
      return { ...result, identity: await api.suggestIdentity().catch(() => null) }
    }),

    route(ENDPOINTS.forget, 'POST', async (body) => opener.forget(body.repo)),

    route(ENDPOINTS.reveal, 'POST', async (body) => {
      const record = opener.resolve(body.repo)
      if (record === null) return { ok: false, error: `没有登记过的仓库：${body.repo}` }
      if (!fs.existsSync(record.path)) return { ok: false, error: `目录不存在：${record.path}` }
      // explorer.exe 成功时也可能返回非 0，这里只看有没有起来
      await run('explorer.exe', [record.path], { timeoutMs: 8_000 })
      return { ok: true, path: record.path }
    }),
  ]
}

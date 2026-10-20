/**
 * GitHub REST 客户端：列仓库、取用户身份。
 *
 * 网络：默认用全局 fetch 直连 api.github.com；配了本地代理（或直连失败）时
 * 退到 curl（Windows 10+ 自带），curl 原生支持 --proxy，也自动吃 http_proxy
 * 环境变量，省掉给 fetch 挂 dispatcher 的依赖。
 */

import { resolveCurl, run } from './proc.js'

/**
 * 解析用户给的仓库输入，兼容多种写法。
 * @param {string} input - owner/repo、https 地址、ssh 地址、镜像包裹的地址。
 * @returns {{owner: string, repo: string, fullName: string} | null}
 */
export function parseRepoInput(input) {
  if (typeof input !== 'string') return null
  let value = input.trim()
  if (value === '') return null
  // owner/repo 简写
  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value)
  if (shorthand !== null) return build(shorthand[1], shorthand[2])
  // 镜像前缀：https://ghfast.top/https://github.com/o/r.git
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(?=https?:\/\/)/i, '')
  const matched = /github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[?#].*)?$/i.exec(value)
  if (matched === null) return null
  return build(matched[1], matched[2])
}

/** 组装结果，挡掉明显不是仓库名的值。 */
function build(owner, repo) {
  if (owner === '' || repo === '' || repo === '.git') return null
  return { owner, repo, fullName: `${owner}/${repo}` }
}

/** 一个 GitHub REST 客户端。 */
export class GitHubApi {
  /** @param {import('./store.js').SettingsStore} store */
  constructor(store) {
    this.store = store
  }

  /** 带 token 的请求头。 */
  #headers() {
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-github-workspaces',
    }
    const token = this.store.token()
    if (token !== '') headers.authorization = `Bearer ${token}`
    return headers
  }

  /** 用 curl 走代理（或兜底）取一次响应。 */
  async #curl(url, headers, proxy) {
    const curl = await resolveCurl()
    if (curl === null) throw new Error('未找到 curl：无法通过代理访问 GitHub API（Windows 10+ 自带 curl.exe）')
    const args = ['-sS', '--max-time', '25', '-w', '\n%{http_code}']
    for (const [key, value] of Object.entries(headers)) args.push('-H', `${key}: ${value}`)
    if (typeof proxy === 'string' && proxy !== '') args.push('--proxy', proxy)
    args.push(url)
    const result = await run(curl, args, { timeoutMs: 30_000 })
    if (result.timedOut) throw new Error('访问 GitHub API 超时（25s）：换镜像或配本地代理')
    if (result.code !== 0) throw new Error(`curl 失败：${(result.stderr || result.error || '').trim()}`)
    const cut = result.stdout.lastIndexOf('\n')
    const status = Number(result.stdout.slice(cut + 1).trim())
    return { status: Number.isFinite(status) ? status : 0, text: result.stdout.slice(0, Math.max(0, cut)) }
  }

  /** GET 一个 API 路径，返回解析后的 JSON。 */
  async request(pathname) {
    const base = (this.store.state.network.apiBase || 'https://api.github.com').replace(/\/$/, '')
    const url = `${base}${pathname}`
    const headers = this.#headers()
    const proxy = this.store.proxy()
    let status = 0
    let text = ''
    if (proxy !== '') {
      const response = await this.#curl(url, headers, proxy)
      status = response.status
      text = response.text
    } else {
      try {
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
        status = response.status
        text = await response.text()
      } catch (error) {
        // 直连失败时用 curl 再试一次（curl 会自动吃 http_proxy/HTTPS_PROXY）
        const response = await this.#curl(url, headers, '')
        status = response.status
        text = response.text
        if (status === 0) {
          throw new Error(`访问 GitHub API 失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    return interpret(status, text)
  }

  /** 当前 token 对应的账号；没 token 时返回 null。 */
  async whoami() {
    if (this.store.token() === '') return null
    const user = await this.request('/user')
    return { login: user.login, id: user.id, name: typeof user.name === 'string' ? user.name : '' }
  }

  /** 列出可见仓库（最多 300 个，按最近更新排序）。 */
  async listRepos() {
    if (this.store.token() === '') throw new Error('列出仓库需要 GitHub Token（面板设置里填，或设置 GITHUB_TOKEN 环境变量）')
    const repos = []
    for (let page = 1; page <= 3; page += 1) {
      const batch = await this.request(
        `/user/repos?per_page=100&sort=updated&affiliation=owner%2Ccollaborator%2Corganization_member&page=${page}`,
      )
      if (!Array.isArray(batch) || batch.length === 0) break
      for (const item of batch) {
        repos.push({
          fullName: item.full_name,
          name: item.name,
          owner: item.owner?.login ?? item.full_name.split('/')[0],
          private: item.private === true,
          fork: item.fork === true,
          archived: item.archived === true,
          defaultBranch: item.default_branch ?? 'main',
          updatedAt: item.updated_at ?? '',
          description: typeof item.description === 'string' ? item.description : '',
          htmlUrl: item.html_url ?? '',
          sizeKb: typeof item.size === 'number' ? item.size : 0,
        })
      }
      if (batch.length < 100) break
    }
    return repos.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  }

  /** 从 token 推导提交身份（GitHub 的 noreply 邮箱形式）。 */
  async suggestIdentity() {
    const user = await this.whoami()
    if (user === null) return null
    return { name: user.login, email: `${user.id}+${user.login}@users.noreply.github.com` }
  }
}

/** 把 HTTP 状态翻成人能看懂的报错。 */
function interpret(status, text) {
  if (status === 200 || status === 201) {
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('GitHub API 返回了无法解析的 JSON')
    }
  }
  if (status === 0) throw new Error('GitHub API 不可达：检查网络、镜像或本地代理')
  if (status === 401) throw new Error('GitHub Token 无效或已过期（401）：在面板设置里换一个')
  if (status === 403) throw new Error('GitHub 拒绝访问（403）：可能是限流，或 token 缺少 repo 权限')
  if (status === 404) throw new Error('仓库不存在，或该 token 无权访问这个私有仓库（404）')
  throw new Error(`GitHub API 返回 ${status}：${text.slice(0, 300)}`)
}

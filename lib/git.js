/**
 * git 执行器：克隆、状态、拉取、提交推送，以及「国内网络」的四条降级路线。
 *
 * 设计要点
 * - origin 永远归一成 https://github.com/<owner>/<repo>.git；加速只在单次
 *   clone/fetch 的 URL 上加前缀，避免把镜像地址写死进仓库配置。
 * - 拉取只做快进（merge --ff-only）：分叉时明确报「需人工处理」，绝不 reset、
 *   绝不 force push。
 * - 所有返回给上层的报错都洗过 token。
 */

import fs from 'node:fs'
import path from 'node:path'
import { resolveGit, run } from './proc.js'
import { MIRROR_CANDIDATES } from './store.js'
import { parseRepoInput } from './github.js'

/** 每个 git 调用都带上的稳定化配置（大仓库 / 中文路径 / 弱网）。 */
const BASE_CONFIG = [
  '-c', 'core.longpaths=true',
  '-c', 'http.version=HTTP/1.1',
  '-c', 'core.quotepath=false',
]

/** 降级顺序：直连 → SSH over 443 → 镜像前缀（镜像比 SSH 更容易失效，放最后）。 */
const AUTO_ORDER = ['direct', 'ssh443', 'mirror']

/** 把输出里可能出现的一次性 token 抹掉。 */
export function redact(text, token) {
  let out = typeof text === 'string' ? text : String(text ?? '')
  if (typeof token === 'string' && token.length > 8) out = out.split(token).join('***')
  out = out.replace(/x-access-token:[^@\s]+@/gi, 'x-access-token:***@')
  out = out.replace(/(https?:\/\/)[^@\s/]+:[^@\s/]+@/gi, '$1***@')
  return out
}

/** 取错误详情里最有信息量的尾部。 */
function tail(text, limit = 700) {
  const value = typeof text === 'string' ? text.trim() : ''
  return value.length <= limit ? value : value.slice(value.length - limit)
}

/** 递归删除目录（克隆失败后清理半成品）。 */
export function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    /* 删不掉就让下一次尝试去覆盖 */
  }
}

/** 把 token 嵌进 https 地址（GitHub 接受 x-access-token 作为用户名）。 */
export function authUrl(httpsUrl, token) {
  if (typeof token !== 'string' || token === '') return httpsUrl
  return httpsUrl.replace(/^https:\/\//, `https://x-access-token:${token}@`)
}

/** 解析 "a\tb" 形式的两列计数。 */
function splitCounts(text) {
  const match = /^(\d+)\s+(\d+)$/m.exec((text ?? '').trim())
  if (match === null) return { ahead: 0, behind: 0 }
  return { ahead: Number(match[1]), behind: Number(match[2]) }
}

/** git 执行器。 */
export class GitRunner {
  /** @param {import('./store.js').SettingsStore} store */
  constructor(store) {
    this.store = store
    /** 上次成功用过的读策略：auto 模式下提到最前，避免每次先白等直连超时。 */
    this.preferred = ''
  }

  /** 底层调用：统一补上 GIT_TERMINAL_PROMPT=0，绝不因为没终端而挂住。 */
  async git(args, options = {}) {
    const resolved = await resolveGit()
    if (resolved === null) {
      return {
        code: null, stdout: '', stderr: '', timedOut: false, durationMs: 0,
        error: '未找到 git 可执行文件：请安装 Git for Windows 并确保 git 在 PATH 里',
      }
    }
    return run(resolved.path, args, {
      ...options,
      env: {
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        LC_ALL: 'C',
        ...(options.env ?? {}),
      },
    })
  }

  /** git 版本信息（面板与诊断用）。 */
  async version() {
    const resolved = await resolveGit()
    if (resolved === null) return null
    return resolved.version
  }

  /** 某一策略下的远端地址与附加 -c 配置。 */
  urlFor(fullName, strategy, token, mirror) {
    const httpsUrl = `https://github.com/${fullName}.git`
    if (strategy === 'mirror') {
      const prefix = (mirror ?? this.store.state.network.mirror ?? MIRROR_CANDIDATES[0]).replace(/\/?$/, '/')
      return { url: `${prefix}${httpsUrl}`, config: [] }
    }
    if (strategy === 'ssh443') {
      return {
        url: `git@github.com:${fullName}.git`,
        config: ['-c', 'url.ssh://git@ssh.github.com:443/.insteadOf=git@github.com:'],
      }
    }
    return { url: authUrl(httpsUrl, token), config: [] }
  }

  /** 读操作可用的策略列表；auto 模式下把上次成功的策略提到最前。 */
  strategies(mode) {
    const value = mode ?? this.store.state.network.mode
    if (value === 'direct') return ['direct']
    if (value === 'ssh443') return ['ssh443', 'direct']
    if (value === 'mirror') return ['mirror', 'direct']
    if (this.preferred !== '' && this.preferred !== 'mirror') {
      return [this.preferred, ...AUTO_ORDER.filter((strategy) => strategy !== this.preferred)]
    }
    return AUTO_ORDER
  }

  /** 一个策略展开成若干次尝试（镜像有多个候选）。 */
  attempts(mode) {
    const list = []
    for (const strategy of this.strategies(mode)) {
      if (strategy === 'mirror') {
        const configured = this.store.state.network.mirror
        const candidates = [configured, ...MIRROR_CANDIDATES].filter(
          (value, index, all) => typeof value === 'string' && value !== '' && all.indexOf(value) === index,
        )
        for (const mirror of candidates) list.push({ strategy, mirror })
      } else {
        list.push({ strategy, mirror: undefined })
      }
    }
    return list
  }

  /**
   * 克隆一个仓库到 dest。
   * @returns {Promise<{ok: boolean, strategy?: string, mirror?: string, failures?: Array<{strategy: string, mirror?: string, error: string}>}>}
   */
  async clone({ fullName, dest, mode, token, shallow = true }) {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const failures = []
    for (const { strategy, mirror } of this.attempts(mode)) {
      removeDir(dest)
      const { url, config } = this.urlFor(fullName, strategy, token, mirror)
      const depthArgs = shallow ? ['--depth', '1', '--single-branch'] : []
      const result = await this.git(
        [...BASE_CONFIG, ...config, 'clone', ...depthArgs, '--no-tags', '--quiet', url, dest],
        { timeoutMs: 420_000 },
      )
      if (result.code === 0) {
        this.preferred = strategy
        // origin 归一成真实地址：以后拉取由 pull() 自己按策略加加速。
        await this.git([...BASE_CONFIG, '-C', dest, 'remote', 'set-url', 'origin', `https://github.com/${fullName}.git`], {
          timeoutMs: 20_000,
        })
        return { ok: true, strategy, mirror }
      }
      failures.push({
        strategy,
        mirror,
        error: tail(redact(result.stderr || result.stdout || result.error || '未知错误', token)),
      })
      if (result.error === '未找到 git 可执行文件：请安装 Git for Windows 并确保 git 在 PATH 里') break
    }
    removeDir(dest)
    return { ok: false, failures }
  }

  /** 从 origin 解析 owner/repo 与当前分支。 */
  async repoMeta(dir) {
    const remote = await this.git([...BASE_CONFIG, '-C', dir, 'remote', 'get-url', 'origin'], { timeoutMs: 20_000 })
    if (remote.code !== 0) return null
    const parsed = parseRepoInput(remote.stdout.trim())
    if (parsed === null) return null
    const branch = await this.currentBranch(dir)
    if (branch === null) return null
    return { ...parsed, branch, origin: redact(remote.stdout.trim()) }
  }

  /** 当前分支名（游离头返回 null）。 */
  async currentBranch(dir) {
    const result = await this.git([...BASE_CONFIG, '-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 20_000 })
    if (result.code !== 0) return null
    const name = result.stdout.trim()
    return name === '' || name === 'HEAD' ? null : name
  }

  /** 单个仓库的本地状态。 */
  async status(dir) {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      return { ok: false, error: '目录不存在或不是 git 仓库', path: dir }
    }
    const [branchResult, statusResult, logResult, upstreamResult, meta] = await Promise.all([
      this.git([...BASE_CONFIG, '-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 20_000 }),
      this.git([...BASE_CONFIG, '-C', dir, 'status', '--porcelain=v1'], { timeoutMs: 30_000 }),
      this.git([...BASE_CONFIG, '-C', dir, 'log', '-1', '--format=%h%x09%cs%x09%s'], { timeoutMs: 20_000 }),
      this.git([...BASE_CONFIG, '-C', dir, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], { timeoutMs: 20_000 }),
      this.repoMeta(dir),
    ])
    const changed = statusResult.code === 0
      ? statusResult.stdout.split('\n').filter((line) => line.trim() !== '')
      : []
    const counts = upstreamResult.code === 0 ? splitCounts(upstreamResult.stdout) : { ahead: 0, behind: 0 }
    const headParts = logResult.code === 0 ? logResult.stdout.trim().split('\t') : []
    return {
      ok: true,
      path: dir,
      fullName: meta === null ? '' : meta.fullName,
      branch: branchResult.code === 0 ? branchResult.stdout.trim() : '',
      tracking: upstreamResult.code === 0,
      ahead: counts.ahead,
      behind: counts.behind,
      dirty: changed.length,
      files: changed.slice(0, 40).map((line) => line.slice(3)),
      head: {
        sha: headParts[0] ?? '',
        date: headParts[1] ?? '',
        subject: headParts[2] ?? '',
      },
      shallow: fs.existsSync(path.join(dir, '.git', 'shallow')),
    }
  }

  /**
   * 拉取（只快进）。分叉时不动工作区，返回需要人工处理的结论。
   * @returns {Promise<{ok: boolean, strategy?: string, upToDate?: boolean, error?: string, detail?: string, failures?: Array<object>}>}
   */
  async pull(dir, mode, token) {
    const meta = await this.repoMeta(dir)
    if (meta === null) return { ok: false, error: '无法从 origin 解析出 GitHub 仓库地址' }
    const failures = []
    const shallow = fs.existsSync(path.join(dir, '.git', 'shallow'))
    for (const { strategy, mirror } of this.attempts(mode)) {
      const { url, config } = this.urlFor(meta.fullName, strategy, token, mirror)
      const depthArgs = shallow ? ['--depth', '1'] : []
      const fetched = await this.git(
        [...BASE_CONFIG, ...config, '-C', dir, 'fetch', ...depthArgs, '--no-tags', url, meta.branch],
        { timeoutMs: 300_000 },
      )
      if (fetched.code !== 0) {
        failures.push({ strategy, mirror, error: tail(redact(fetched.stderr || fetched.error || 'fetch 失败', token)) })
        continue
      }
      const merged = await this.git([...BASE_CONFIG, '-C', dir, 'merge', '--ff-only', 'FETCH_HEAD'], { timeoutMs: 60_000 })
      if (merged.code === 0) {
        this.preferred = strategy
        return { ok: true, strategy, upToDate: /Already up to date/i.test(merged.stdout), branch: meta.branch }
      }
      return {
        ok: false,
        error: '快进失败：本地与远端已分叉，脚本不会 reset 或强推',
        detail: tail(redact(merged.stderr || merged.stdout, token)),
      }
    }
    return { ok: false, error: '所有拉取策略都失败了', failures }
  }

  /** 读一个 git 配置项（仓库级 → 全局）。 */
  async configValue(dir, key) {
    const result = await this.git([...BASE_CONFIG, '-C', dir, 'config', '--get', key], { timeoutMs: 15_000 })
    return result.code === 0 ? result.stdout.trim() : ''
  }

  /**
   * 提交并推送。只在面板里由用户显式触发。
   * @returns {Promise<{ok: boolean, committed?: boolean, pushed?: boolean, branch?: string, error?: string, detail?: string}>}
   */
  async commitAndPush(dir, { message, mode, token }) {
    const status = await this.status(dir)
    if (!status.ok) return { ok: false, error: status.error ?? '工作区不可用' }
    const meta = await this.repoMeta(dir)
    if (meta === null) return { ok: false, error: '无法从 origin 解析出 GitHub 仓库地址' }

    const text = typeof message === 'string' && message.trim() !== '' ? message.trim() : `更新: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
    let committed = false

    if (status.dirty > 0) {
      const added = await this.git([...BASE_CONFIG, '-C', dir, 'add', '-A'], { timeoutMs: 120_000 })
      if (added.code !== 0) return { ok: false, error: 'git add 失败', detail: tail(redact(added.stderr, token)) }
      const name = this.store.state.author.name || (await this.configValue(dir, 'user.name'))
      const email = this.store.state.author.email || (await this.configValue(dir, 'user.email'))
      if (name === '' || email === '') {
        return {
          ok: false,
          error: '缺少提交身份：在面板设置里填作者名与邮箱（建议用 GitHub 的 noreply 邮箱）',
          detail: '也可以先执行 git config --global user.name / user.email',
        }
      }
      const commit = await this.git(
        [...BASE_CONFIG, '-C', dir, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-m', text],
        { timeoutMs: 120_000 },
      )
      if (commit.code !== 0) {
        const detail = tail(redact(`${commit.stderr}\n${commit.stdout}`, token))
        return { ok: false, error: 'git commit 失败', detail }
      }
      committed = true
    }

    // 推送只能走直连或 SSH：镜像前缀基本是只读的。
    const pushOrder = mode === 'ssh443' || this.preferred === 'ssh443' ? ['ssh443', 'direct'] : ['direct', 'ssh443']
    let pushProblem = { error: '推送失败', detail: '', committed, branch: meta.branch }
    for (const strategy of pushOrder) {
      const { url, config } = this.urlFor(meta.fullName, strategy, token)
      const push = await this.git(
        [...BASE_CONFIG, ...config, '-C', dir, 'push', url, `HEAD:${meta.branch}`],
        { timeoutMs: 300_000 },
      )
      if (push.code === 0) {
        this.preferred = strategy
        return { ok: true, committed, pushed: true, branch: meta.branch, strategy }
      }
      const detail = tail(redact(`${push.stderr}\n${push.stdout}`, token))
      const authProblem = /Authentication failed|could not read Username|terminal prompts disabled|403/i.test(detail)
      pushProblem = {
        error: authProblem
          ? '推送被拒：需要一个有写权限的 GitHub Token（面板设置里配），或配好 SSH 密钥'
          : `推送失败（${strategy}）`,
        detail,
        committed,
        branch: meta.branch,
      }
    }
    return pushProblem
  }

  /**
   * 网络体检：直连 / 每个镜像候选 / SSH-over-443 各做一次 ls-remote 计时，
   * 并把最快成功的读策略记为后续优先。
   * @returns {Promise<{ok: boolean, git: string|null, preferred: string, rows: Array<{strategy: string, mirror?: string, ok: boolean, ms: number, error?: string}>}>}
   */
  async diagnose() {
    const version = await this.version()
    const rows = []
    const probe = 'octocat/Hello-World'
    const mirrors = [this.store.state.network.mirror, ...MIRROR_CANDIDATES].filter(
      (value, index, all) => typeof value === 'string' && value !== '' && all.indexOf(value) === index,
    )
    const targets = [
      { strategy: 'direct', mirror: undefined },
      ...mirrors.map((mirror) => ({ strategy: 'mirror', mirror })),
      { strategy: 'ssh443', mirror: undefined },
    ]
    for (const { strategy, mirror } of targets) {
      const { url, config } = this.urlFor(probe, strategy, this.store.token(), mirror)
      const result = await this.git([...BASE_CONFIG, ...config, 'ls-remote', '--heads', url], { timeoutMs: 20_000 })
      rows.push({
        strategy,
        mirror,
        ok: result.code === 0,
        ms: result.durationMs,
        error: result.code === 0 ? undefined : tail(redact(result.error ?? result.stderr, this.store.token()), 200),
      })
    }
    // 最快成功的读策略记下来：后续克隆/拉取直接用，不再每次先等直连超时
    const reachable = rows.filter((row) => row.ok).sort((a, b) => a.ms - b.ms)
    if (reachable.length > 0) this.preferred = reachable[0].strategy
    return { ok: true, git: version, preferred: this.preferred, rows }
  }
}

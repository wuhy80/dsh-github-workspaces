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

/**
 * 远端跟踪 ref 的落点。
 *
 * 这是 P1 那个 bug 的根：按 URL fetch 时如果不写 refspec，git 只更新
 * FETCH_HEAD，`refs/remotes/origin/*` 会一直停在旧提交；status() 的
 * ahead/behind 正是拿 `@{upstream}` 比的，于是拉完还会一直显示「待拉 N」。
 */
export function trackingRef(branch) {
  return `refs/remotes/origin/${branch}`
}

/**
 * fetch 参数。
 *
 * 注意这里**没有 `--depth 1`**：带浅标记抓下来的新提交本身是浅边界（没有父
 * 提交），git 会判定它和本地 HEAD 无关，`merge --ff-only` 直接报
 * `refusing to merge unrelated histories`。实测：不加 depth 或 `--deepen 1`
 * 都能正常 Fast-forward。
 */
export function fetchArgs(url, branch) {
  return ['fetch', '--no-tags', url, `+${branch}:${trackingRef(branch)}`]
}

/** 快进合并参数：合跟踪 ref，而不是 FETCH_HEAD。 */
export function mergeArgs(branch) {
  return ['merge', '--ff-only', trackingRef(branch)]
}

/** 分叉时的整合参数：变基或合并，都对着跟踪 ref。 */
export function integrateArgs(mode, branch) {
  return mode === 'rebase'
    ? ['rebase', trackingRef(branch)]
    : ['merge', '--no-edit', trackingRef(branch)]
}

/** 从 git 进度输出里抠百分比，例如 "Receiving objects:  45% (9/20)"。 */
function percentReader(onProgress) {
  if (typeof onProgress !== 'function') return undefined
  let last = -1
  return (chunk) => {
    const matched = /(\d{1,3})%/.exec(chunk)
    if (matched === null) return
    const percent = Number(matched[1])
    // git 会同时打 "remote:" 与 "Receiving objects:" 两路进度，取单调递增的那路
    if (!Number.isFinite(percent) || percent <= last) return
    last = percent
    onProgress({ percent })
  }
}

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

/** 策略的可读名字（进度与自检共用）。 */
function describeStrategy(strategy, mirror) {
  if (strategy === 'mirror') return `镜像 ${mirror ?? ''}`.trim()
  if (strategy === 'ssh443') return 'SSH-over-443'
  return '直连'
}

/** 状态码 → 面板上的中文标签。 */
export function statusLabel(index, worktree) {
  if (index === '?' && worktree === '?') return '未跟踪'
  if (index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A') || (index === 'D' && worktree === 'D')) return '冲突'
  if (index === 'R' || worktree === 'R') return '重命名'
  if (index === 'C' || worktree === 'C') return '复制'
  if (index === 'D' || worktree === 'D') return '删除'
  if (index === 'A') return '新增'
  return '修改'
}

/**
 * 解析 `git status --porcelain=v1 -z`。
 *
 * 用 -z 而不是普通格式：路径不转义（中文/空格/引号都不会被 git 包一层），
 * 重命名条目则是「新路径\0旧路径」，要吃掉下一段。
 * @param {string} stdout - git 的原始输出。
 * @returns {Array<{path: string, index: string, worktree: string, renamedFrom?: string, untracked: boolean, label: string}>}
 */
export function parseStatusZ(stdout) {
  const parts = String(stdout ?? '').split('\0')
  const files = []
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]
    if (typeof entry !== 'string' || entry.length < 4) continue
    const index = entry[0]
    const worktree = entry[1]
    const filePath = entry.slice(3)
    let renamedFrom
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
      const previous = parts[i + 1]
      if (typeof previous === 'string' && previous !== '') {
        renamedFrom = previous
        i += 1
      }
    }
    files.push({
      path: filePath,
      index,
      worktree,
      renamedFrom,
      untracked: index === '?' && worktree === '?',
      label: statusLabel(index, worktree),
    })
  }
  return files
}

/** 截断超长文本（diff / 新文件内容）。 */
function clipText(text, limit) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n\n… 已截断（共 ${value.length} 字符）`
}

/** 报错压成字符串。 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
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

  /** 读操作可用的策略列表；auto 模式下把上次成功的策略（含持久化的）提到最前。 */
  strategies(mode) {
    const value = mode ?? this.store.state.network.mode
    if (value === 'direct') return ['direct']
    if (value === 'ssh443') return ['ssh443', 'direct']
    if (value === 'mirror') return ['mirror', 'direct']
    const preferred = this.preferred || this.store.state.network.preferred
    if (typeof preferred === 'string' && AUTO_ORDER.includes(preferred)) {
      return [preferred, ...AUTO_ORDER.filter((strategy) => strategy !== preferred)]
    }
    return AUTO_ORDER
  }

  /** 记住可用策略：内存 + 设置文件，重启后第一次克隆不用再白等直连超时。 */
  rememberStrategy(strategy) {
    if (typeof strategy !== 'string' || strategy === '') return
    this.preferred = strategy
    try {
      this.store.setPreferred(strategy)
    } catch {
      /* 写设置失败不影响本次会话 */
    }
  }

  /** 本地代理要同时作用在 git 自己身上，否则「proxy」模式只对 GitHub API 生效。 */
  proxyArgs() {
    const proxy = this.store.proxy()
    if (proxy === '') return []
    return ['-c', `http.proxy=${proxy}`, '-c', `https.proxy=${proxy}`]
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
   * @param {{fullName: string, dest: string, mode?: string, token?: string, shallow?: boolean,
   *          signal?: AbortSignal, onStage?: Function, onProgress?: Function}} request
   * @returns {Promise<{ok: boolean, strategy?: string, mirror?: string, aborted?: boolean, failures?: Array<{strategy: string, mirror?: string, error: string}>}>}
   */
  async clone({ fullName, dest, mode, token, shallow = true, signal, onStage, onProgress }) {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const failures = []
    for (const { strategy, mirror } of this.attempts(mode)) {
      if (signal?.aborted === true) return { ok: false, aborted: true, failures }
      removeDir(dest)
      const { url, config } = this.urlFor(fullName, strategy, token, mirror)
      onStage?.({ stage: 'clone', text: `克隆中（${describeStrategy(strategy, mirror)}）…` })
      const depthArgs = shallow ? ['--depth', '1', '--single-branch'] : []
      const result = await this.git(
        [...BASE_CONFIG, ...this.proxyArgs(), ...config, 'clone', ...depthArgs, '--no-tags', '--progress', url, dest],
        { timeoutMs: 420_000, signal, onStderr: percentReader(onProgress) },
      )
      if (result.code === 0) {
        this.rememberStrategy(strategy)
        // origin 归一成真实地址：以后拉取由 pull() 自己按策略加加速。
        await this.git([...BASE_CONFIG, '-C', dest, 'remote', 'set-url', 'origin', `https://github.com/${fullName}.git`], {
          timeoutMs: 20_000,
        })
        return { ok: true, strategy, mirror }
      }
      if (result.aborted === true) {
        removeDir(dest)
        return { ok: false, aborted: true, failures }
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

  /** 当前仓库是否停在 rebase / merge / cherry-pick 中间态。 */
  repoState(dir) {
    const gitDir = path.join(dir, '.git')
    if (fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))) return 'rebasing'
    if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) return 'merging'
    if (fs.existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-picking'
    return 'clean'
  }

  /** 未解决的冲突文件。 */
  async conflictedFiles(dir) {
    const result = await this.git([...BASE_CONFIG, '-C', dir, 'diff', '--name-only', '--diff-filter=U'], { timeoutMs: 30_000 })
    if (result.code !== 0) return []
    return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
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
    const state = this.repoState(dir)
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
      state,
      conflicts: state === 'clean' ? [] : await this.conflictedFiles(dir),
    }
  }

  /**
   * 抓取远端分支到 `refs/remotes/origin/<branch>`，按策略逐级降级。
   * pull 与分叉整合共用这一段（fetch 不带 `--depth`，理由见 fetchArgs）。
   * @returns {Promise<{ok: boolean, strategy?: string, aborted?: boolean, error?: string, failures?: Array<object>}>}
   */
  async fetchTracking(dir, meta, { mode, token, signal, onStage } = {}) {
    const failures = []
    for (const { strategy, mirror } of this.attempts(mode)) {
      if (signal?.aborted === true) return { ok: false, aborted: true, failures }
      const { url, config } = this.urlFor(meta.fullName, strategy, token, mirror)
      onStage?.({ stage: 'fetch', text: `抓取中（${describeStrategy(strategy, mirror)}）…` })
      const fetched = await this.git(
        [...BASE_CONFIG, ...this.proxyArgs(), ...config, '-C', dir, ...fetchArgs(url, meta.branch)],
        { timeoutMs: 300_000, signal },
      )
      if (fetched.code === 0) return { ok: true, strategy }
      if (fetched.aborted === true) return { ok: false, aborted: true, failures }
      failures.push({ strategy, mirror, error: tail(redact(fetched.stderr || fetched.error || 'fetch 失败', token)) })
    }
    return { ok: false, error: '所有抓取策略都失败了', failures }
  }

  /**
   * 拉取（只快进）。分叉时不动工作区，把「分叉」这个结论交给面板去处理。
   *
   * 关键两点（P0/P1）：
   * - fetch 不带 `--depth`：带浅标记的提交无法证明祖先关系，ff-only 会失败；
   * - fetch 写显式 refspec、merge 合跟踪 ref：否则 `refs/remotes/origin/*` 不前进，
   *   ahead/behind 会一直显示错误的「待拉 N」。
   * @param {string} dir - 工作区路径。
   * @param {string} [mode] - 覆盖设置里的网络策略。
   * @param {string} [token] - GitHub token。
   * @param {{signal?: AbortSignal, onStage?: Function}} [options] - 取消与进度回调。
   */
  async pull(dir, mode, token, options = {}) {
    const { signal, onStage } = options
    const meta = await this.repoMeta(dir)
    if (meta === null) return { ok: false, error: '无法从 origin 解析出 GitHub 仓库地址' }
    const fetched = await this.fetchTracking(dir, meta, { mode, token, signal, onStage })
    if (fetched.ok !== true) return fetched
    onStage?.({ stage: 'merge', text: '快进合并…' })
    const merged = await this.git([...BASE_CONFIG, '-C', dir, ...mergeArgs(meta.branch)], { timeoutMs: 60_000, signal })
    if (merged.code === 0) {
      this.rememberStrategy(fetched.strategy)
      return { ok: true, strategy: fetched.strategy, upToDate: /Already up to date/i.test(merged.stdout), branch: meta.branch }
    }
    const conflicts = await this.conflictedFiles(dir)
    return {
      ok: false,
      diverged: true,
      conflicts,
      error: '本地与远端已分叉：快进失败（不会 reset、不会强推）',
      hint: '在卡片上选「变基到远端」或「合并远端」，也可以在终端里手动处理',
      detail: tail(redact(merged.stderr || merged.stdout, token)),
    }
  }

  /**
   * 分叉整合：把本地提交变基到远端，或合并远端。必须由用户在面板里显式选择。
   * @param {string} dir - 工作区路径。
   * @param {'rebase'|'merge'} mode - 整合方式。
   * @param {{signal?: AbortSignal, onStage?: Function, token?: string}} [options]
   */
  async integrate(dir, mode, { signal, onStage, token } = {}) {
    if (mode !== 'rebase' && mode !== 'merge') return { ok: false, error: `未知的整合方式：${mode}` }
    const status = await this.status(dir)
    if (!status.ok) return { ok: false, error: status.error ?? '工作区不可用' }
    if (status.state !== 'clean') {
      return {
        ok: false,
        state: status.state,
        conflicts: status.conflicts ?? [],
        error: `仓库正处在${status.state === 'rebasing' ? '变基' : '合并'}中间态：先「继续」或「中止」`,
      }
    }
    if (status.dirty > 0) {
      return { ok: false, error: `还有 ${status.dirty} 个未提交的改动：先在「改动」里提交，再处理分叉`, dirty: status.dirty }
    }
    const meta = await this.repoMeta(dir)
    if (meta === null) return { ok: false, error: '无法从 origin 解析出 GitHub 仓库地址' }

    const fetched = await this.fetchTracking(dir, meta, { token, signal, onStage })
    if (fetched.ok !== true) return fetched
    if (fetched.strategy !== undefined) this.rememberStrategy(fetched.strategy)

    const afterFetch = await this.status(dir)
    if (afterFetch.ok && afterFetch.behind === 0) {
      return { ok: true, upToDate: true, branch: meta.branch, ahead: afterFetch.ahead, behind: 0 }
    }

    onStage?.({ stage: 'integrate', text: mode === 'rebase' ? '变基到远端…' : '合并远端…' })
    const result = await this.git([...BASE_CONFIG, '-C', dir, ...integrateArgs(mode, meta.branch)], {
      timeoutMs: 180_000,
      signal,
      env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
    })
    if (result.code === 0) {
      const after = await this.status(dir)
      return { ok: true, mode, branch: meta.branch, ahead: after.ahead ?? 0, behind: after.behind ?? 0 }
    }
    const conflicts = await this.conflictedFiles(dir)
    const state = this.repoState(dir)
    const conflicted = conflicts.length > 0 || state !== 'clean'
    return {
      ok: false,
      conflict: conflicted,
      state,
      conflicts,
      error: conflicted
        ? `整合时发生冲突（${conflicts.length} 个文件）：面板里不能编辑文件，请在工作区里解决后点「继续」，或点「中止」回到原状`
        : '整合失败',
      detail: tail(redact(`${result.stderr}\n${result.stdout}`, token)),
    }
  }

  /** 中止留在中间态的 rebase / merge，回到整合前的状态。 */
  async abortIntegration(dir) {
    const state = this.repoState(dir)
    if (state === 'clean') return { ok: true, noop: true, state }
    const args = state === 'rebasing'
      ? ['rebase', '--abort']
      : state === 'merging' ? ['merge', '--abort'] : ['cherry-pick', '--abort']
    const result = await this.git([...BASE_CONFIG, '-C', dir, ...args], { timeoutMs: 60_000 })
    if (result.code !== 0) {
      return { ok: false, error: '中止失败', detail: tail(redact(result.stderr || result.stdout)), state: this.repoState(dir) }
    }
    return { ok: true, state: this.repoState(dir) }
  }

  /** 冲突解决之后的「继续」：rebase --continue 或 merge 收尾提交。 */
  async continueIntegration(dir) {
    const state = this.repoState(dir)
    if (state === 'clean') return { ok: true, noop: true, state }
    const remaining = await this.conflictedFiles(dir)
    if (remaining.length > 0) {
      return { ok: false, error: `还有 ${remaining.length} 个文件没解决冲突`, conflicts: remaining, state }
    }
    const args = state === 'rebasing' ? ['rebase', '--continue'] : ['commit', '--no-edit']
    const result = await this.git([...BASE_CONFIG, '-C', dir, ...args], {
      timeoutMs: 120_000,
      env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
    })
    if (result.code !== 0) {
      const conflicts = await this.conflictedFiles(dir)
      return {
        ok: false,
        error: '继续失败',
        conflicts,
        state: this.repoState(dir),
        detail: tail(redact(`${result.stderr}\n${result.stdout}`)),
      }
    }
    return { ok: true, state: this.repoState(dir) }
  }

  /** 读一个 git 配置项（仓库级 → 全局）。 */
  async configValue(dir, key) {
    const result = await this.git([...BASE_CONFIG, '-C', dir, 'config', '--get', key], { timeoutMs: 15_000 })
    return result.code === 0 ? result.stdout.trim() : ''
  }

  /** 工作区里的改动列表（面板的勾选列表用）。 */
  async changedFiles(dir) {
    if (!fs.existsSync(path.join(dir, '.git'))) return []
    const result = await this.git([...BASE_CONFIG, '-C', dir, 'status', '--porcelain=v1', '-z'], { timeoutMs: 30_000 })
    if (result.code !== 0) return []
    return parseStatusZ(result.stdout)
  }

  /**
   * 单个文件的 diff（暂存 + 未暂存，相对 HEAD）。
   * 未跟踪文件没有 diff，直接回内容。
   */
  async fileDiff(dir, filePath, limit = 200_000) {
    if (typeof filePath !== 'string' || filePath === '') return { ok: false, error: '缺少文件路径' }
    const files = await this.changedFiles(dir)
    const entry = files.find((file) => file.path === filePath)
    if (entry === undefined) return { ok: false, error: `改动里没有这个文件：${filePath}` }
    if (entry.untracked === true) {
      try {
        const absolute = path.join(dir, filePath)
        const stat = fs.statSync(absolute)
        if (stat.size > limit) {
          return { ok: true, path: filePath, kind: 'binary', text: `文件较大（${Math.round(stat.size / 1024)} KB），不在面板里展开` }
        }
        const content = fs.readFileSync(absolute, 'utf8')
        if (content.includes('\u0000')) return { ok: true, path: filePath, kind: 'binary', text: '二进制文件，不展开' }
        return { ok: true, path: filePath, kind: 'new', text: clipText(content, limit) }
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      }
    }
    const diff = await this.git([...BASE_CONFIG, '-C', dir, 'diff', 'HEAD', '--', filePath], { timeoutMs: 60_000 })
    if (diff.code !== 0) return { ok: false, error: 'git diff 失败', detail: tail(redact(diff.stderr)) }
    const text = diff.stdout
    if (/^Binary files /m.test(text)) return { ok: true, path: filePath, kind: 'binary', text: '二进制文件，不展开' }
    return { ok: true, path: filePath, kind: entry.label, text: clipText(text, limit) }
  }

  /**
   * 提交选中的文件并推送。
   *
   * 与旧版 `add -A` 的区别：只暂存用户勾选的文件；重命名会连旧路径一起 stage。
   * @param {string} dir - 工作区路径。
   * @param {{paths?: string[]|null, message?: string, mode?: string, token?: string,
   *          signal?: AbortSignal, onStage?: Function}} request - paths 为空表示全部改动。
   */
  async commitSelected(dir, { paths = null, message, mode, token, signal, onStage }) {
    const status = await this.status(dir)
    if (!status.ok) return { ok: false, error: status.error ?? '工作区不可用' }
    if (status.dirty === 0) return { ok: false, error: '没有未提交的改动' }
    const meta = await this.repoMeta(dir)
    if (meta === null) return { ok: false, error: '无法从 origin 解析出 GitHub 仓库地址' }

    const changed = await this.changedFiles(dir)
    const requested = Array.isArray(paths) && paths.length > 0
      ? paths.filter((item) => typeof item === 'string' && item !== '')
      : null
    const selected = requested === null ? changed.map((file) => file.path) : requested
    if (selected.length === 0) return { ok: false, error: '没有选中任何文件' }

    // 重命名要连旧路径一起 stage，否则只提交新路径、删除动作留在索引里
    const staged = new Set(selected)
    for (const file of changed) {
      if (file.renamedFrom !== undefined && selected.includes(file.path)) staged.add(file.renamedFrom)
    }

    onStage?.({ stage: 'add', text: `暂存 ${staged.size} 个文件…` })
    const added = await this.git([...BASE_CONFIG, '-C', dir, 'add', '-A', '--', ...staged], { timeoutMs: 120_000, signal })
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

    const text = typeof message === 'string' && message.trim() !== ''
      ? message.trim()
      : `更新: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
    onStage?.({ stage: 'commit', text: `提交 ${staged.size} 个文件…` })
    const commit = await this.git(
      [...BASE_CONFIG, '-C', dir, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-m', text],
      { timeoutMs: 120_000, signal },
    )
    if (commit.code !== 0) {
      const detail = tail(redact(`${commit.stderr}\n${commit.stdout}`, token))
      return { ok: false, error: 'git commit 失败', detail }
    }

    const pushed = await this.pushBranch(dir, meta, { mode, token, signal, onStage })
    if (pushed.ok !== true) return { ...pushed, committed: true, branch: meta.branch }
    return { ok: true, committed: true, pushed: true, branch: meta.branch, strategy: pushed.strategy, files: staged.size }
  }

  /**
   * 把当前 HEAD 推到远端（不提交）。变基之后、或在终端里提交过之后都用它。
   * @param {string} dir - 工作区路径。
   * @param {{mode?: string, token?: string, signal?: AbortSignal, onStage?: Function}} [options]
   */
  async pushHead(dir, { mode, token, signal, onStage } = {}) {
    const status = await this.status(dir)
    if (!status.ok) return { ok: false, error: status.error ?? '工作区不可用' }
    const meta = await this.repoMeta(dir)
    if (meta === null) return { ok: false, error: '无法从 origin 解析出 GitHub 仓库地址' }
    const pushed = await this.pushBranch(dir, meta, { mode, token, signal, onStage })
    return pushed.ok === true ? { ...pushed, pushed: true } : pushed
  }

  /**
   * 推送循环：直连 → SSH-over-443（镜像只读，不参与推送）。
   * 成功后补 update-ref，否则 status 会一直显示「待推」。
   */
  async pushBranch(dir, meta, { mode, token, signal, onStage } = {}) {
    const pushOrder = mode === 'ssh443' || this.preferred === 'ssh443' ? ['ssh443', 'direct'] : ['direct', 'ssh443']
    let problem = { ok: false, error: '推送失败', detail: '' }
    for (const strategy of pushOrder) {
      if (signal?.aborted === true) return { ok: false, aborted: true }
      onStage?.({ stage: 'push', text: `推送中（${describeStrategy(strategy)}）…` })
      const { url, config } = this.urlFor(meta.fullName, strategy, token)
      const push = await this.git(
        [...BASE_CONFIG, ...this.proxyArgs(), ...config, '-C', dir, 'push', url, `HEAD:${meta.branch}`],
        { timeoutMs: 300_000, signal },
      )
      if (push.code === 0) {
        this.rememberStrategy(strategy)
        await this.git([...BASE_CONFIG, '-C', dir, 'update-ref', trackingRef(meta.branch), 'HEAD'], { timeoutMs: 20_000 })
        return { ok: true, strategy, branch: meta.branch }
      }
      if (push.aborted === true) return { ok: false, aborted: true }
      const detail = tail(redact(`${push.stderr}\n${push.stdout}`, token))
      const authProblem = /Authentication failed|could not read Username|terminal prompts disabled|403/i.test(detail)
      problem = {
        ok: false,
        error: authProblem
          ? '推送被拒：需要一个有写权限的 GitHub Token（面板设置里配），或配好 SSH 密钥'
          : `推送失败（${strategy}）`,
        detail,
      }
    }
    return problem
  }

  /** 兼容旧调用：不传 paths 时提交全部改动。 */
  async commitAndPush(dir, request) {
    return this.commitSelected(dir, request)
  }

  /**
   * 网络体检：直连 / 每个镜像候选 / SSH-over-443 各做一次 ls-remote 计时，
   * 并把最快成功的读策略记为后续优先。
   * @returns {Promise<{ok: boolean, git: string|null, preferred: string, rows: Array<{strategy: string, mirror?: string, ok: boolean, ms: number, error?: string}>}>}
   */
  async diagnose() {
    const version = await this.version()
    const probe = 'octocat/Hello-World'
    const mirrors = [this.store.state.network.mirror, ...MIRROR_CANDIDATES].filter(
      (value, index, all) => typeof value === 'string' && value !== '' && all.indexOf(value) === index,
    )
    const targets = [
      { strategy: 'direct', mirror: undefined },
      ...mirrors.map((mirror) => ({ strategy: 'mirror', mirror })),
      { strategy: 'ssh443', mirror: undefined },
    ]
    // 并行探，且单条 8 秒就判死：串行 20 秒 × 5 条要等近百秒
    const rows = await Promise.all(targets.map(async ({ strategy, mirror }) => {
      const { url, config } = this.urlFor(probe, strategy, this.store.token(), mirror)
      const result = await this.git(
        [...BASE_CONFIG, ...this.proxyArgs(), ...config, 'ls-remote', '--heads', url],
        { timeoutMs: 8_000 },
      )
      return {
        strategy,
        mirror,
        label: describeStrategy(strategy, mirror),
        ok: result.code === 0,
        ms: result.durationMs,
        error: result.code === 0 ? undefined : tail(redact(result.error ?? result.stderr, this.store.token()), 200),
      }
    }))
    // 最快成功的读策略记下来（含持久化）：后续克隆/拉取直接用，不再每次先等直连超时
    const reachable = rows.filter((row) => row.ok).sort((a, b) => a.ms - b.ms)
    if (reachable.length > 0) this.rememberStrategy(reachable[0].strategy)
    return { ok: true, git: version, preferred: this.preferred || this.store.state.network.preferred, rows }
  }
}

/**
 * 把「一个 GitHub 仓库」落成「一个 DSH 工作区」。
 *
 * 顺序是刻意设计的：先克隆成功，再登记工作区。这样任何一步失败都不会留下
 * 一个指向空目录的工作区；反过来，克隆已经成功但登记失败时，目录会保留，
 * 面板里再点一次「打开」就能补登记。
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseRepoInput } from './github.js'
import { archiveKind, countEscapes, extractArchive, unwrapSingleDirectory } from './archive.js'

/** 报错翻成字符串。 */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 路径比较（Windows 大小写不敏感、忽略尾部分隔符）。 */
function samePath(left, right) {
  const normalize = (value) => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase()
  return normalize(left) === normalize(right)
}

/** 仓库 → 工作区 的门面。 */
export class WorkspaceOpener {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文（要 workspaceRegistry）。
   * @param {import('./store.js').SettingsStore} store
   * @param {import('./git.js').GitRunner} git
   * @param {import('./github.js').GitHubApi} api
   */
  constructor(ctx, store, git, api) {
    this.ctx = ctx
    this.store = store
    this.git = git
    this.api = api
  }

  /** 该路径已经登记成工作区时返回它的 id。 */
  workspaceIdFor(target) {
    try {
      const hit = this.ctx.workspaceRegistry.list().find((workspace) => samePath(workspace.path, target))
      return hit === undefined ? '' : hit.id
    } catch {
      return ''
    }
  }

  /**
   * 打开一个仓库：必要时克隆，然后以仓库名登记为工作区。
   * @param {{input?: string, fullName?: string, url?: string, mode?: string}} [request]
   */
  async open(request = {}) {
    const source = request.input ?? request.fullName ?? request.url ?? ''
    const ref = parseRepoInput(source)
    if (ref === null) {
      return {
        ok: false,
        error: '无法识别仓库地址',
        detail: '支持 owner/repo、https://github.com/owner/repo、git@github.com:owner/repo.git',
      }
    }
    const token = this.store.token()
    let root
    try {
      // 「没有就建立一个」：克隆根不存在时先把目录建出来
      root = this.store.ensureCloneRoot()
    } catch (error) {
      return { ok: false, error: message(error) }
    }
    const dest = path.join(root, ref.owner, ref.repo)
    const { signal, onStage, onProgress } = request
    let cloned = false
    let strategy = ''
    if (fs.existsSync(path.join(dest, '.git'))) {
      onStage?.({ stage: 'reuse', text: '本地已有该仓库，直接复用' })
    } else if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
      return {
        ok: false,
        error: `目标目录已存在且不是 git 仓库：${dest}`,
        hint: '删掉这个目录，或换个克隆根目录后重试',
      }
    } else {
      const result = await this.git.clone({
        fullName: ref.fullName,
        dest,
        mode: request.mode,
        token,
        shallow: this.store.state.clone.shallow,
        signal,
        onStage,
        onProgress,
      })
      if (result.aborted === true) return { ok: false, aborted: true, error: '已取消' }
      if (!result.ok) {
        return { ok: false, error: '克隆失败：所有加速策略都没成功', failures: result.failures ?? [] }
      }
      cloned = true
      strategy = result.mirror === undefined ? result.strategy : `${result.strategy}(${result.mirror})`
    }

    let workspace
    try {
      onStage?.({ stage: 'register', text: '登记为 DSH 工作区…' })
      workspace = await this.ctx.workspaceRegistry.create(dest, ref.repo)
    } catch (error) {
      return {
        ok: false,
        path: dest,
        cloned,
        error: `仓库已就位，但登记工作区失败：${message(error)}`,
      }
    }
    this.store.remember(ref.fullName, { path: dest, title: ref.repo })
    return {
      ok: true,
      fullName: ref.fullName,
      name: ref.repo,
      title: workspace.title,
      path: dest,
      workspaceId: workspace.id,
      cloned,
      strategy,
    }
  }

  /**
   * 从浏览器下载的归档导入成「只读快照」工作区。
   *
   * 没有 .git，所以只能读、不能提交推送；面板会标成「只读快照」。
   * @param {{fullName: string, archivePath: string, name?: string, onStage?: Function,
   *          signal?: AbortSignal}} request
   */
  async importArchive({ fullName, archivePath, name, onStage, signal }) {
    const ref = parseRepoInput(fullName)
    if (ref === null) return { ok: false, error: '请填 owner/repo（例如 wuhy80/obsidian-vault）' }
    if (archiveKind(name ?? archivePath) === '') {
      return { ok: false, error: '只支持 .zip / .tar.gz / .tgz / .tar' }
    }
    let root
    try {
      root = this.store.ensureCloneRoot()
    } catch (error) {
      return { ok: false, error: message(error) }
    }
    const dest = path.join(root, ref.owner, ref.repo)
    if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
      return {
        ok: false,
        error: `目标目录已存在且非空：${dest}`,
        hint: '先「移除登记」并删掉该目录，或换个 owner/repo',
      }
    }

    fs.mkdirSync(dest, { recursive: true })
    try {
      onStage?.({ stage: 'extract', text: '解压中…' })
      const extracted = await extractArchive(archivePath, dest, { signal, onStage })
      if (extracted.ok !== true) {
        fs.rmSync(dest, { recursive: true, force: true })
        return { ok: false, error: extracted.error ?? '解压失败', aborted: extracted.aborted === true }
      }
      unwrapSingleDirectory(dest)
      const escapes = countEscapes(dest)
      if (escapes > 0) {
        fs.rmSync(dest, { recursive: true, force: true })
        return { ok: false, error: `归档里有 ${escapes} 个条目跑到目标目录之外，已放弃导入` }
      }
      const entries = fs.readdirSync(dest)
      if (entries.length === 0) {
        fs.rmSync(dest, { recursive: true, force: true })
        return { ok: false, error: '归档解开后是空的' }
      }

      onStage?.({ stage: 'register', text: '登记为工作区（只读快照）…' })
      const workspace = await this.ctx.workspaceRegistry.create(dest, ref.repo)
      this.store.remember(ref.fullName, { path: dest, title: ref.repo, snapshot: true, source: 'archive' })
      return {
        ok: true,
        fullName: ref.fullName,
        title: workspace.title,
        path: dest,
        workspaceId: workspace.id,
        snapshot: true,
        entries: entries.length,
      }
    } catch (error) {
      fs.rmSync(dest, { recursive: true, force: true })
      return { ok: false, error: `导入失败：${message(error)}` }
    }
  }

  /** 已登记仓库的实时状态（面板首屏用）。 */
  async list() {
    const records = this.store.records()
    return Promise.all(
      records.map(async (record) => {
        const workspaceId = this.workspaceIdFor(record.path)
        const dirExists = fs.existsSync(record.path)
        const isRepo = dirExists && fs.existsSync(path.join(record.path, '.git'))
        if (!dirExists) {
          return { ...record, workspaceId, exists: false, branch: '', ahead: 0, behind: 0, dirty: 0, files: [], head: {}, state: 'clean', conflicts: [] }
        }
        if (!isRepo) {
          // 只读快照：目录在、但不是 git 仓库
          return { ...record, workspaceId, exists: true, snapshot: true, branch: '', ahead: 0, behind: 0, dirty: 0, files: [], head: {}, state: 'clean', conflicts: [] }
        }
        const status = await this.git.status(record.path)
        if (!status.ok) {
          return { ...record, workspaceId, exists: true, branch: '', ahead: 0, behind: 0, dirty: 0, files: [], head: {}, state: 'clean', conflicts: [], error: status.error }
        }
        return {
          ...record,
          workspaceId,
          exists: true,
          branch: status.branch,
          ahead: status.ahead,
          behind: status.behind,
          dirty: status.dirty,
          files: status.files,
          head: status.head,
          tracking: status.tracking,
          shallow: status.shallow,
          // 面板据此显示「分叉」与「变基/合并中间态」两个块
          state: status.state ?? 'clean',
          conflicts: status.conflicts ?? [],
          error: undefined,
        }
      }),
    )
  }

  /**
   * 所有工作区的轻量摘要（侧边栏角标用，不发网络请求）。
   * @returns {Promise<{ok: boolean, total: number, behindRepos: number, behindCommits: number, aheadCommits: number, dirtyRepos: number, repos: Array<object>}>}
   */
  async summaryAll() {
    const records = this.store.records()
    const repos = await Promise.all(records.map(async (record) => ({
      fullName: record.fullName,
      title: record.title,
      ...(await this.git.summarize(record.path)),
    })))
    const totals = { total: repos.length, behindRepos: 0, behindCommits: 0, aheadCommits: 0, dirtyRepos: 0 }
    for (const item of repos) {
      if (item.ok !== true) continue
      if ((item.behind ?? 0) > 0) totals.behindRepos += 1
      totals.behindCommits += item.behind ?? 0
      totals.aheadCommits += item.ahead ?? 0
      if ((item.dirty ?? 0) > 0) totals.dirtyRepos += 1
    }
    return { ok: true, ...totals, repos }
  }

  /** 检查更新：对所有仓库抓取（只 fetch，不合并）。 */
  async checkUpdates(options = {}) {
    return this.#each('fetch', options)
  }

  /** 全部拉取：逐个 fetch + 快进；分叉与失败的分开列出，绝不自动整合。 */
  async pullAll(options = {}) {
    return this.#each('pull', options)
  }

  /**
   * 只读快照的写操作护栏。
   * @returns {{ok: false, error: string} | null} 命中快照时返回拒绝理由。
   */
  #writeGuard(record) {
    if (record !== null && record !== undefined && record.snapshot === true) {
      return { ok: false, error: '这是从归档导入的只读快照（没有 git 历史）：不能提交、推送、拉取或切分支' }
    }
    return null
  }

  /** 批量执行的公共骨架。 */
  async #each(kind, { signal, onStage } = {}) {
    const records = this.store.records()
    const total = records.length
    const report = {
      ok: true,
      kind,
      total,
      done: 0,
      pulled: 0,
      upToDate: 0,
      fetched: 0,
      skipped: 0,
      diverged: [],
      failed: [],
      aborted: false,
    }
    let index = 0
    for (const record of records) {
      if (signal?.aborted === true) {
        report.aborted = true
        break
      }
      index += 1
      onStage?.({ stage: 'repo', text: `${index}/${total} ${record.fullName}…`, index, total, fullName: record.fullName })
      if (record.snapshot === true) {
        // 只读快照不参与批量网络操作
        report.skipped += 1
        report.done = index
        continue
      }
      const outcome = kind === 'pull'
        ? await this.git.pull(record.path, undefined, this.store.token(), { signal })
        : await this.git.fetchOnly(record.path, { signal })
      report.done = index
      if (outcome.ok !== true) {
        if (outcome.aborted === true) {
          report.aborted = true
          break
        }
        if (outcome.diverged === true) report.diverged.push(record.fullName)
        else report.failed.push({ fullName: record.fullName, error: outcome.error ?? '失败' })
        continue
      }
      if (kind === 'pull') {
        if (outcome.upToDate === true) report.upToDate += 1
        else report.pulled += 1
      } else {
        report.fetched += 1
      }
      this.store.remember(record.fullName, {})
    }
    const summary = await this.summaryAll()
    report.behindRepos = summary.behindRepos
    report.behindCommits = summary.behindCommits
    return report
  }

  /** 找到一条登记，不存在返回 null。 */
  resolve(fullName) {
    if (typeof fullName !== 'string') return null
    const record = this.store.state.repos[fullName]
    return record === undefined ? null : { fullName, ...record }
  }

  /** 单个仓库状态。 */
  async status(fullName) {
    const record = this.resolve(fullName)
    if (record === null) return { ok: false, error: `没有登记过的仓库：${fullName}` }
    const status = await this.git.status(record.path)
    return { ...status, fullName, workspaceId: this.workspaceIdFor(record.path) }
  }

  /**
   * 拉取（只快进）。
   * @param {string} fullName - owner/repo。
   * @param {{signal?: AbortSignal, onStage?: Function, mode?: string}} [options] - 取消、进度与策略覆盖。
   */
  async pull(fullName, options = {}) {
    const record = this.resolve(fullName)
    if (record === null) return { ok: false, error: `没有登记过的仓库：${fullName}` }
    const guard = this.#writeGuard(record)
    if (guard !== null) return guard
    const result = await this.git.pull(record.path, options.mode, this.store.token(), {
      signal: options.signal,
      onStage: options.onStage,
    })
    if (result.ok) this.store.remember(fullName, {})
    return { ...result, fullName }
  }

  /** 本地与远端分支列表。 */
  async branches(fullName) {
    const record = this.resolve(fullName)
    if (record === null) return { ok: false, error: `没有登记过的仓库：${fullName}` }
    const guard = this.#writeGuard(record)
    if (guard !== null) return guard
    return { ...(await this.git.branches(record.path)), fullName }
  }

  /** 切换分支（`origin/x` 会建本地跟踪分支；create 为真时从当前 HEAD 新建）。 */
  async checkout(fullName, name, options = {}) {
    const record = this.resolve(fullName)
    if (record === null) return { ok: false, error: `没有登记过的仓库：${fullName}` }
    const guard = this.#writeGuard(record)
    if (guard !== null) return guard
    const result = await this.git.checkout(record.path, name, { create: options.create === true })
    if (result.ok) this.store.remember(fullName, {})
    return { ...result, fullName }
  }

  /** 删除本地分支（只做安全删除）。 */
  async deleteBranch(fullName, name) {
    const record = this.resolve(fullName)
    if (record === null) return { ok: false, error: `没有登记过的仓库：${fullName}` }
    const guard = this.#writeGuard(record)
    if (guard !== null) return guard
    return { ...(await this.git.deleteBranch(record.path, name)), fullName }
  }

  /** 工作区的改动列表（勾选用）。 */
  async changes(fullName) {
    const record = this.resolve(fullName)
    if (record === null) return { ok: false, error: `没有登记过的仓库：${fullName}` }
    return { ok: true, fullName, files: await this.git.changedFiles(record.path) }
  }

  /** 单个文件的 diff。 */
  async diff(fullName, filePath) {
    const record = this.resolve(fullName)
    if (record === null) return { ok: false, error: `没有登记过的仓库：${fullName}` }
    return this.git.fileDiff(record.path, filePath)
  }

  /** 分叉整合（用户显式选择变基或合并）。 */
  async integrate(fullName, mode, options = {}) {
    const record = this.resolve(fullName)
    if (record === null) return { ok: false, error: `没有登记过的仓库：${fullName}` }
    const guard = this.#writeGuard(record)
    if (guard !== null) return guard
    const result = await this.git.integrate(record.path, mode, {
      token: this.store.token(),
      signal: options.signal,
      onStage: options.onStage,
    })
    if (result.ok) this.store.remember(fullName, {})
    return { ...result, fullName }
  }

  /** 中止停在中间态的变基/合并。 */
  async abortIntegration(fullName) {
    const record = this.resolve(fullName)
    if (record === null) return { ok: false, error: `没有登记过的仓库：${fullName}` }
    return { ...(await this.git.abortIntegration(record.path)), fullName }
  }

  /** 冲突解决之后继续。 */
  async continueIntegration(fullName) {
    const record = this.resolve(fullName)
    if (record === null) return { ok: false, error: `没有登记过的仓库：${fullName}` }
    return { ...(await this.git.continueIntegration(record.path)), fullName }
  }

  /** 只推送（变基之后，或在终端里提交过之后）。 */
  async push(fullName, options = {}) {
    const record = this.resolve(fullName)
    if (record === null) return { ok: false, error: `没有登记过的仓库：${fullName}` }
    const guard = this.#writeGuard(record)
    if (guard !== null) return guard
    const result = await this.git.pushHead(record.path, {
      token: this.store.token(),
      signal: options.signal,
      onStage: options.onStage,
    })
    if (result.ok) this.store.remember(fullName, {})
    return { ...result, fullName }
  }

  /** 提交并推送选中的文件（只在面板里由用户触发）。
   * @param {string} fullName - owner/repo。
   * @param {string} text - 提交信息。
   * @param {string[]|null} [paths] - 勾选的文件；空/不传表示全部改动。
   * @param {{signal?: AbortSignal, onStage?: Function}} [options]
   */
  async commit(fullName, text, paths, options = {}) {
    const record = this.resolve(fullName)
    if (record === null) return { ok: false, error: `没有登记过的仓库：${fullName}` }
    const guard = this.#writeGuard(record)
    if (guard !== null) return guard
    const result = await this.git.commitSelected(record.path, {
      paths: Array.isArray(paths) ? paths : null,
      message: text,
      token: this.store.token(),
      signal: options.signal,
      onStage: options.onStage,
    })
    if (result.ok) this.store.remember(fullName, {})
    return { ...result, fullName }
  }

  /** 取消工作区登记（保留磁盘文件）。 */
  async forget(fullName) {
    const record = this.resolve(fullName)
    if (record === null) return { ok: false, error: `没有登记过的仓库：${fullName}` }
    const workspaceId = this.workspaceIdFor(record.path)
    let removed = false
    if (workspaceId !== '') {
      try {
        removed = await this.ctx.workspaceRegistry.delete(workspaceId)
      } catch (error) {
        return { ok: false, error: `删除工作区登记失败：${message(error)}` }
      }
    }
    this.store.forget(fullName)
    return { ok: true, fullName, removedWorkspace: removed, keptPath: record.path }
  }
}

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

  /** 已登记仓库的实时状态（面板首屏用）。 */
  async list() {
    const records = this.store.records()
    return Promise.all(
      records.map(async (record) => {
        const workspaceId = this.workspaceIdFor(record.path)
        if (!fs.existsSync(path.join(record.path, '.git'))) {
          return { ...record, workspaceId, exists: false, branch: '', ahead: 0, behind: 0, dirty: 0, files: [], head: {}, state: 'clean', conflicts: [] }
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
    const result = await this.git.pull(record.path, options.mode, this.store.token(), {
      signal: options.signal,
      onStage: options.onStage,
    })
    if (result.ok) this.store.remember(fullName, {})
    return { ...result, fullName }
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

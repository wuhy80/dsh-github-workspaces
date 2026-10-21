/**
 * 设置与仓库登记（$DSH_HOME/dsh-github-workspaces.json，权限 0600）。
 *
 * 不用 Cordis 的 Config schema：那会引入 schemastery 依赖，而这个包是手写
 * 纯 JS（无构建步骤）。设置页因此就近放在插件自己的面板里。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** DSH 主目录：优先 DSH_HOME，否则 ~/.dsh。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

/** 设置文件名（放在 DSH 主目录，跨 profile 共享）。 */
const FILE_NAME = 'dsh-github-workspaces.json'

/** 国内网络策略：auto 会按 direct → mirror → ssh443 依次降级。 */
export const NETWORK_MODES = ['auto', 'direct', 'mirror', 'proxy', 'ssh443']

/** 镜像前缀候选：面板里可以只填一个，这里给出常用备选。 */
export const MIRROR_CANDIDATES = ['https://ghfast.top/', 'https://gh-proxy.com/', 'https://ghproxy.net/']

/**
 * 默认克隆根目录。
 *
 * Windows 上落到 `D:\githubCode`（GitHub 仓库与代码统一放 D 盘），其他平台放主目录下。
 * 目录不存在时由 {@link SettingsStore#ensureCloneRoot} 建出来。
 */
export function defaultCloneRoot() {
  if (process.platform === 'win32') return 'D:\\githubCode'
  return path.join(os.homedir(), 'dsh-github-workspaces')
}

/** 设置默认值。 */
function defaults() {
  return {
    version: 1,
    /** GitHub PAT；不填则读环境变量。 */
    token: '',
    /** 克隆根目录；每个仓库落在 <cloneRoot>/<owner>/<repo>。 */
    cloneRoot: defaultCloneRoot(),
    network: {
      mode: 'auto',
      /** 镜像前缀（如 https://ghfast.top/），auto/mirror 模式使用。 */
      mirror: MIRROR_CANDIDATES[0],
      /** 本地代理，如 http://127.0.0.1:7890；空串表示不用。 */
      proxy: '',
      /** 最近一次实测可用的读策略（auto 模式优先用它）；空串表示还没测过。 */
      preferred: '',
      /** GitHub API 基址，可换镜像。 */
      apiBase: 'https://api.github.com',
    },
    author: {
      /** 提交身份；留空则读 git 全局配置，再留空则从 token 推导。 */
      name: '',
      email: '',
    },
    clone: {
      /** 浅克隆（--depth 1 --single-branch），国内网络下体感差别很大。 */
      shallow: true,
    },
    /** "owner/repo" → { path, title, openedAt, lastUsedAt } */
    repos: {},
  }
}

/** 只取对象里已知的键，其余忽略。 */
function pickObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

/** 归一化读到的 JSON，保证形状稳定，坏值退回默认。 */
function normalize(raw) {
  const base = defaults()
  const input = pickObject(raw)
  const network = pickObject(input.network)
  const author = pickObject(input.author)
  const clone = pickObject(input.clone)
  const repos = {}
  for (const [key, value] of Object.entries(pickObject(input.repos))) {
    const record = pickObject(value)
    if (typeof record.path !== 'string' || record.path === '') continue
    repos[key] = {
      path: record.path,
      title: typeof record.title === 'string' && record.title !== '' ? record.title : key.split('/').pop() ?? key,
      openedAt: typeof record.openedAt === 'string' ? record.openedAt : '',
      lastUsedAt: typeof record.lastUsedAt === 'string' ? record.lastUsedAt : '',
    }
  }
  const mode = NETWORK_MODES.includes(network.mode) ? network.mode : base.network.mode
  return {
    version: 1,
    token: typeof input.token === 'string' ? input.token.trim() : '',
    cloneRoot: typeof input.cloneRoot === 'string' && input.cloneRoot.trim() !== '' ? path.resolve(input.cloneRoot.trim()) : base.cloneRoot,
    network: {
      mode,
      mirror: typeof network.mirror === 'string' ? network.mirror.trim() : base.network.mirror,
      preferred: typeof network.preferred === 'string' && ['direct', 'mirror', 'ssh443'].includes(network.preferred)
        ? network.preferred
        : '',
      proxy: typeof network.proxy === 'string' ? network.proxy.trim() : '',
      apiBase: typeof network.apiBase === 'string' && network.apiBase.trim() !== '' ? network.apiBase.trim() : base.network.apiBase,
    },
    author: {
      name: typeof author.name === 'string' ? author.name.trim() : '',
      email: typeof author.email === 'string' ? author.email.trim() : '',
    },
    clone: { shallow: clone.shallow !== false },
    repos,
  }
}

/** 设置与仓库登记的门面。 */
export class SettingsStore {
  /** @param {string} [home] - 覆盖 DSH 主目录（测试用）。 */
  constructor(home) {
    this.dir = home === undefined ? dshHome() : home
    this.file = path.join(this.dir, FILE_NAME)
    this.state = this.#read()
  }

  /** @returns {ReturnType<typeof defaults>} */
  #read() {
    try {
      const text = fs.readFileSync(this.file, 'utf8')
      return normalize(JSON.parse(text))
    } catch {
      return defaults()
    }
  }

  /** 原子写回（先写临时文件再 rename），权限 0600。 */
  #write() {
    fs.mkdirSync(this.dir, { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temp, this.file)
  }

  /** 面板可写的字段白名单。 */
  update(patch) {
    const input = pickObject(patch)
    if (typeof input.token === 'string') this.state.token = input.token.trim()
    if (typeof input.cloneRoot === 'string' && input.cloneRoot.trim() !== '') this.state.cloneRoot = path.resolve(input.cloneRoot.trim())
    const network = pickObject(input.network)
    if (Object.keys(network).length > 0) {
      if (NETWORK_MODES.includes(network.mode)) this.state.network.mode = network.mode
      if (typeof network.mirror === 'string') this.state.network.mirror = network.mirror.trim()
      if (typeof network.proxy === 'string') this.state.network.proxy = network.proxy.trim()
      if (typeof network.apiBase === 'string' && network.apiBase.trim() !== '') this.state.network.apiBase = network.apiBase.trim()
    }
    const author = pickObject(input.author)
    if (Object.keys(author).length > 0) {
      if (typeof author.name === 'string') this.state.author.name = author.name.trim()
      if (typeof author.email === 'string') this.state.author.email = author.email.trim()
    }
    const clone = pickObject(input.clone)
    if (typeof clone.shallow === 'boolean') this.state.clone.shallow = clone.shallow
    this.#write()
    return this.snapshot()
  }

  /** 当前 token：环境变量优先，其次文件。 */
  token() {
    const env = [process.env.GITHUB_TOKEN, process.env.GH_TOKEN, process.env.GITHUB_PAT]
      .find((value) => typeof value === 'string' && value.trim() !== '')
    if (env !== undefined) return env.trim()
    return this.state.token
  }

  /** token 来源（给面板显示，不暴露内容）。 */
  tokenSource() {
    const env = [process.env.GITHUB_TOKEN, process.env.GH_TOKEN, process.env.GITHUB_PAT]
      .find((value) => typeof value === 'string' && value.trim() !== '')
    if (env !== undefined) return 'env'
    return this.state.token === '' ? '' : 'file'
  }

  /** 本地代理地址，空串表示不用。 */
  proxy() {
    if (this.state.network.mode === 'direct') return ''
    return this.state.network.proxy
  }

  /** 记住最近可用的读策略（auto 模式据此把它排到最前）。 */
  setPreferred(strategy) {
    if (!['direct', 'mirror', 'ssh443'].includes(strategy)) return
    if (this.state.network.preferred === strategy) return
    this.state.network.preferred = strategy
    this.#write()
  }

  /** 克隆根目录（绝对路径）。 */
  cloneRoot() {
    return path.resolve(this.state.cloneRoot)
  }

  /**
   * 克隆根目录：不存在就建出来（含多级父目录）。
   * @returns {string} 可用的绝对路径。
   * @throws {Error} 盘符不存在或无权限时抛出带原因的错误。
   */
  ensureCloneRoot() {
    const root = this.cloneRoot()
    try {
      fs.mkdirSync(root, { recursive: true })
    } catch (error) {
      const reason = error?.code === 'ENOENT'
        ? '盘符或上级目录不存在'
        : error?.code === 'EACCES' || error?.code === 'EPERM'
          ? '没有写权限'
          : error instanceof Error ? error.message : String(error)
      throw new Error(`无法创建克隆根目录 ${root}：${reason}（可在面板设置里改）`)
    }
    return root
  }

  /** 给面板的快照：token 只给「有没有」，不给内容。 */
  snapshot() {
    const source = this.tokenSource()
    return {
      hasToken: source !== '',
      tokenSource: source,
      cloneRoot: this.cloneRoot(),
      network: { ...this.state.network },
      author: { ...this.state.author },
      clone: { ...this.state.clone },
      mirrorCandidates: [...MIRROR_CANDIDATES],
      workspaces: this.records(),
      settingsFile: this.file,
    }
  }

  /** 已登记的仓库行。 */
  records() {
    return Object.entries(this.state.repos)
      .map(([fullName, record]) => ({ fullName, ...record }))
      .sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : a.lastUsedAt > b.lastUsedAt ? -1 : 0))
  }

  /** 登记（或刷新）一个仓库。 */
  remember(fullName, patch) {
    const previous = this.state.repos[fullName] ?? {}
    const now = new Date().toISOString()
    this.state.repos[fullName] = {
      path: patch.path ?? previous.path ?? '',
      title: patch.title ?? previous.title ?? (fullName.split('/').pop() ?? fullName),
      openedAt: previous.openedAt ?? now,
      lastUsedAt: now,
    }
    this.#write()
    return this.state.repos[fullName]
  }

  /** 取消登记（不动磁盘文件）。 */
  forget(fullName) {
    if (this.state.repos[fullName] === undefined) return false
    delete this.state.repos[fullName]
    this.#write()
    return true
  }
}

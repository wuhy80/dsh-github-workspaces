/**
 * A 方案：agent 侧的 git 护栏。
 *
 * 背景：`github_workspace` 工具里没有 commit/push，是刻意把改远端的动作留给面板。
 * 但那个约束只在**工具层**——工作区会话里 agent 有 shell，一条 `git push` 就绕过了
 * 链路降级、token 注入与 token 脱敏。这里用宿主自己的工具调用水闸补上：
 * `tools/pre-execute` 是 waterfall，返回 `{ kind: 'deny', reason }` 就能在工具体
 * 执行前拒掉整次调用（DSH 的 `dsh-tool-call-timeout-policy` 用的是同一族钩子）。
 *
 * 边界（写清楚，免得被当成安全机制）：
 * - 这是**行为护栏**，不是安全边界。命令判定是字符串/分词级别的，绕过手法很多
 *   （写脚本、编码后执行、`--no-verify` 管不到的层面等）。真正拦得住的是 git 层的
 *   `remote.origin.pushurl` 哨兵（见 GitRunner.installPushGuard）。
 * - 只覆盖经过 DSH 工具执行的命令；用户自己在终端 / 编辑器 / GitHub Desktop 里推
 *   不会经过这里。
 * - 判定只针对「改远端或改写历史」的子命令；读命令、本地 `git add` / `git commit`
 *   一律放行（本地提交不联网，也不需要面板）。
 */

import path from 'node:path'

/**
 * C 方案用的哨兵 pushurl：`git push` 不传 URL 时 git 会读它，于是连不出去。
 * 选 127.0.0.1:9（discard 端口）：毫秒级失败，报错里带得出这是被护栏挡的。
 */
export const PUSH_GUARD_URL = 'https://127.0.0.1:9/dsh-github-workspaces-blocked'

/** 宿主环境变量放行开关（只能由用户改宿主环境，agent 改不到）。 */
export const ALLOW_ENV = 'DSH_GITHUB_WORKSPACES_ALLOW_GIT_PUSH'

/**
 * 会跑命令的工具名。
 *
 * `pwsh` / `bash` 是 DSH 内置 shell；`terminal` 是持久终端；`run_code`（PTC）
 * 能在程序里调 shell；`ssh_exec` / `ssh_cluster` 是 dsh-ssh 的远端执行。
 */
export const SHELL_TOOLS = new Set(['pwsh', 'bash', 'terminal', 'run_code', 'ssh_exec', 'ssh_cluster'])

/** 命令分隔符：一个分号/换行之后是另一条命令。 */
const SEPARATORS = new Set([';', '&&', '||', '|', '&', '(', ')', '\n'])

/** 像 git 的可执行名：git、git.exe、git.cmd、D:\Git\bin\git.exe 等。 */
const GIT_TOKEN = /^(?:.*[\\/])?git(?:\.exe|\.cmd|\.bat)?$/i

/** 这些 git 全局选项自带一个值，跳过子命令时要连值一起跳。 */
const OPTIONS_WITH_VALUE = new Set([
  '-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix',
])

/**
 * 把命令切成 token。
 *
 * 引号与反引号直接丢掉（`bash -lc "git push"` 里的内容因此会暴露成独立 token），
 * 空白与分隔符断开 token，换行本身也留成一个分隔符 token——否则
 * `git status\ngit push` 会被当成同一条命令的连续参数而漏判。
 * @param {string} command - 原始命令行。
 * @returns {string[]} token 列表。
 */
export function tokenize(command) {
  const tokens = []
  let current = ''
  const flush = () => {
    if (current !== '') {
      tokens.push(current)
      current = ''
    }
  }
  for (const ch of String(command ?? '')) {
    if (ch === '"' || ch === "'" || ch === '`') {
      flush()
      continue
    }
    if (ch === '\n' || ch === '\r') {
      flush()
      tokens.push('\n')
      continue
    }
    if (';|&()'.includes(ch)) {
      flush()
      tokens.push(ch)
      continue
    }
    if (/\s/.test(ch)) {
      flush()
      continue
    }
    current += ch
  }
  flush()
  return tokens
}

/**
 * 判定一个 git 子命令是否要拦。
 *
 * push 连 `--dry-run` 一起拦：C 方案的 pushurl 哨兵对 dry-run 同样生效（git 仍然
 * 会去连 pushurl），留着「护栏说可以、git 说连不上」只会让人困惑。要看待推数量
 * 用 `git status -sb` 或 `git log @{u}..HEAD`。
 * @param {string} subcommand - 小写子命令。
 * @param {string[]} args - 子命令之后的参数。
 * @returns {{kind: 'push'|'rewrite', action: string} | null} 命中时给出动作名。
 */
function judge(subcommand, args) {
  if (subcommand === 'push') return { kind: 'push', action: '推送' }
  if (subcommand === 'rebase') return { kind: 'rewrite', action: '变基' }
  if (subcommand === 'filter-branch') return { kind: 'rewrite', action: '改写历史' }
  if (subcommand === 'reset' && args.includes('--hard')) return { kind: 'rewrite', action: '硬重置' }
  return null
}

/**
 * 扫一条命令里的 git 子命令，挑出要拦的。
 *
 * 找到 git 之后先跳过全局选项（`-c k=v`、`-C dir` 连值一起跳），第一个非选项 token
 * 才是子命令；然后整段 span（到下一个分隔符）算被这条 git 消费掉，避免
 * `git commit -m "git push"` 里那句提交信息被误判。
 * @param {string} command - 原始命令行。
 * @returns {Array<{kind: 'push'|'rewrite', action: string, subcommand: string}>} 命中项。
 */
export function inspectCommand(command) {
  const tokens = tokenize(command)
  const hits = []
  for (let index = 0; index < tokens.length; index += 1) {
    if (!GIT_TOKEN.test(tokens[index])) continue
    let cursor = index + 1
    while (cursor < tokens.length) {
      const token = tokens[cursor]
      if (SEPARATORS.has(token) || !token.startsWith('-')) break
      const key = token.split('=')[0]
      cursor += OPTIONS_WITH_VALUE.has(key) && !token.includes('=') ? 2 : 1
    }
    if (cursor >= tokens.length || SEPARATORS.has(tokens[cursor])) {
      index = cursor
      continue
    }
    const subcommand = tokens[cursor].toLowerCase()
    const args = []
    let end = cursor + 1
    while (end < tokens.length && !SEPARATORS.has(tokens[end])) {
      args.push(tokens[end])
      end += 1
    }
    const hit = judge(subcommand, args)
    if (hit !== null) hits.push({ ...hit, subcommand })
    index = end
  }
  return hits
}

/**
 * 从工具参数里挑出可能含命令的字段。
 * @param {unknown} args - 工具调用参数。
 * @returns {string[]} 待扫描的字符串。
 */
export function commandFields(args) {
  const values = []
  if (typeof args !== 'object' || args === null) return values
  for (const key of ['command', 'commands', 'cmd', 'code', 'script']) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') values.push(value)
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string' && item !== '') values.push(item)
    }
  }
  return values
}

/** 路径归一：反斜杠转正斜杠、去尾斜杠、小写（Windows 大小写不敏感）。 */
export function normalizePath(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 本插件管辖的路径：克隆根 + 每个已登记仓库。
 * @param {any} store - SettingsStore。
 * @returns {string[]} 归一化后的路径。
 */
export function workspacePaths(store) {
  const paths = new Set()
  const root = normalizePath(store.cloneRoot())
  if (root !== '') paths.add(root)
  for (const record of store.records()) {
    const value = normalizePath(record.path)
    if (value !== '') paths.add(value)
  }
  return [...paths]
}

/**
 * 这次调用是否动到了本插件的仓库。
 *
 * 判据（任一命中即算）：
 * 1. 会话 cwd（或工具显式 workdir）落在克隆根/任一登记仓库里；
 * 2. 命令文本里出现了某个仓库路径（覆盖 `git -C D:\githubCode\o\r push` 这种）。
 * 两条都不命中就放行：别的项目里的 `git push` 不该被这个插件管。
 * @param {any} store - SettingsStore。
 * @param {string} cwd - 解析出的工作目录。
 * @param {string[]} commands - 待扫描的命令文本。
 * @returns {boolean} 是否命中本插件的工作区。
 */
export function touchesWorkspace(store, cwd, commands) {
  const paths = workspacePaths(store)
  if (paths.length === 0) return false
  const cwdValue = normalizePath(cwd)
  if (cwdValue !== '' && paths.some((item) => cwdValue === item || cwdValue.startsWith(`${item}/`))) return true
  const text = normalizePath((commands ?? []).join(' '))
  return paths.some((item) => text.includes(item))
}

/**
 * 拒绝理由：给模型看，要求它改用面板，并说明为什么。
 * @param {Array<{action: string}>} hits - 命中项。
 * @returns {string} 面向模型的说明。
 */
export function blockReason(hits) {
  const actions = [...new Set((hits ?? []).map((hit) => hit.action))].filter((value) => typeof value === 'string')
  return [
    `已阻止：${actions.length === 0 ? '推送' : actions.join('、')} 不在 shell 里执行，请改用「GitHub 工作区」面板。`,
    '面板的「提交并推送 / 变基到远端 / 合并远端」会走 直连 → SSH-over-443 降级、注入 token、把报错里的 token 抹成 ***，并同步面板的待推/待拉计数；shell 里的 git 三样都没有。',
    '只读与本地命令不受限制：git status / log / diff / fetch / add / commit 都能用；看待推数量用 git status -sb 或 git log @{u}..HEAD。',
    `确实需要手动推送时由用户在面板里操作；要临时放行可在宿主环境设 ${ALLOW_ENV}=1，或在面板设置里关掉「shell 提交护栏」。`,
  ].join('\n')
}

/**
 * 解析这次工具调用的工作目录。
 *
 * 优先工具显式给的 workdir，其次问 workingDirectory 服务（与 shell 工具自己解析
 * 默认 cwd 的方式一致）。拿不到就返回空串——调用方据此判定「与本插件无关」。
 * @param {any} ctx - 宿主上下文。
 * @param {any} exec - 工具执行对象。
 * @returns {Promise<string>} 绝对路径或空串。
 */
async function sessionCwd(ctx, exec) {
  const explicit = exec?.arguments?.workdir
  if (typeof explicit === 'string' && explicit !== '') return path.resolve(explicit)
  try {
    const service = ctx.workingDirectory
    if (service !== undefined && typeof service.ensure === 'function') {
      const value = await service.ensure(exec.agent, exec.signal)
      if (typeof value === 'string' && value !== '') return value
    }
  } catch {
    /* 没注入这个服务、或会话还没建目录：退回「与本插件无关」 */
  }
  return ''
}

/**
 * 注册 A 方案护栏。
 *
 * 两层：主路径是 `tools/pre-execute` 水闸（异步，能解析会话 cwd，覆盖「在仓库里
 * 直接 `git push`」）；再叠一个同步的 `tools.guard`（拿不到 cwd，但覆盖「命令里
 * 点名了仓库路径」的形态，例如 `git -C D:\githubCode\o\r push`）。两者都只拒不放，
 * 任一命中即拦，互不冲突。
 *
 * @param {{ctx: any, store: any, log?: (message: string) => void}} deps
 * @returns {() => void} 注销函数。
 */
export function installToolGuard({ ctx, store, log }) {
  const warn = typeof log === 'function' ? log : () => {}
  const disposers = []

  const handler = async (exec, next) => {
    try {
      if (store.state.guard?.tool !== true) return next()
      if (String(process.env[ALLOW_ENV] ?? '') === '1') return next()
      if (!SHELL_TOOLS.has(exec.name)) return next()
      const commands = commandFields(exec.arguments)
      if (commands.length === 0) return next()
      const hits = []
      for (const command of commands) hits.push(...inspectCommand(command))
      if (hits.length === 0) return next()
      const cwd = await sessionCwd(ctx, exec)
      if (!touchesWorkspace(store, cwd, commands)) return next()
      warn(`tool guard denied ${exec.name}: ${hits.map((hit) => hit.subcommand).join(',')}`)
      return { kind: 'deny', reason: blockReason(hits) }
    } catch (error) {
      // 护栏本身出错不该把用户的正常命令卡死：放行并记一笔
      warn(`tool guard error: ${error instanceof Error ? error.message : String(error)}`)
      return next()
    }
  }

  try {
    const dispose = ctx.on('tools/pre-execute', handler)
    if (typeof dispose === 'function') disposers.push(dispose)
  } catch (error) {
    warn(`tool guard waterfall unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 同步兜底：只看命令文本里有没有点名本插件的仓库路径
  try {
    const service = ctx.tools
    if (service !== undefined && typeof service.guard === 'function') {
      const dispose = service.guard((exec) => {
        try {
          if (store.state.guard?.tool !== true) return undefined
          if (String(process.env[ALLOW_ENV] ?? '') === '1') return undefined
          if (!SHELL_TOOLS.has(exec.name)) return undefined
          const commands = commandFields(exec.arguments)
          if (commands.length === 0) return undefined
          const hits = []
          for (const command of commands) hits.push(...inspectCommand(command))
          if (hits.length === 0) return undefined
          if (!touchesWorkspace(store, '', commands)) return undefined
          return blockReason(hits)
        } catch {
          return undefined
        }
      })
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  } catch (error) {
    warn(`tool guard fallback unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 卸载失败不影响其它插件 */
      }
    }
  }
}

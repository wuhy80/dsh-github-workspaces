/**
 * agent 侧的 github_workspace 工具：和面板共用同一套 WorkspaceOpener / GitRunner。
 *
 * 刻意不提供提交与推送动作：那两个动作会改远端状态，属于「用户显式授权」类
 * 操作，只在面板里手动点击。工具只做只读动作与拉取（快进，可回退）。
 *
 * 这个包是手写纯 JS、没有构建步骤，所以不能 import @deepseek-ai/dsh-tools 的
 * defineTool（裸包名在本包里不可解析）；defineTool 本身只是身份函数，直接给
 * 出同样形状的普通对象即可。
 */

/** 模型看的插件说明（systemPrompt 段落）。 */
export const GITHUB_WORKSPACES_GUIDANCE = [
  '本机已安装 dsh-github-workspaces 插件（GitHub 仓库即工作区）：Web 侧边栏有一项「GitHub 工作区」面板。',
  '能力：把 GitHub 仓库克隆到 <cloneRoot>/<owner>/<repo> 并以仓库名登记为 DSH 工作区（标题=仓库名）；面板里可拉取、提交并推送。',
  '国内网络：克隆/拉取按 直连 → 镜像前缀 → SSH-over-443 自动降级；面板设置可配本地代理、镜像前缀与 API 基址。',
  '工具：github_workspace，action = list | status | open | pull | diagnose | repos。',
  '限制：提交与推送不在工具里，只能由用户在面板手动执行；拉取只接受快进，分叉会报「需人工处理」而不是 reset；克隆/拉取消耗真实网络与磁盘，先确认仓库再操作。',
  '用户提到「GitHub 项目/仓库当工作区、从 GitHub 拉取、用仓库名做工作区、国内网络克隆不下来」时即指本插件。',
].join('\n')

/** 文本内容块。 */
function text(value) {
  return [{ type: 'text', text: value }]
}

/** 一行工作区摘要。 */
function line(row) {
  const flags = []
  if (row.exists === false) flags.push('缺失')
  if (row.dirty > 0) flags.push(`改动 ${row.dirty}`)
  if (row.ahead > 0) flags.push(`待推 ${row.ahead}`)
  if (row.behind > 0) flags.push(`待拉 ${row.behind}`)
  if (row.error !== undefined) flags.push('异常')
  return `${row.fullName} | ${row.branch === '' ? '-' : row.branch} | ${flags.length === 0 ? '干净' : flags.join(' ')} | ${row.path}`
}

/** 渲染工作区表。 */
function renderList(rows) {
  if (rows.length === 0) return '还没有从 GitHub 打开过任何仓库。用 action=open 加 input=owner/repo 打开一个。'
  return ['仓库 | 分支 | 状态 | 本地路径', '--- | --- | --- | ---', ...rows.map(line)].join('\n')
}

/** 渲染诊断结果。 */
function renderDiagnose(value) {
  const rows = (value.rows ?? []).map((row) => {
    const target = row.strategy === 'mirror' ? `mirror:${row.mirror}` : row.strategy
    return `${row.ok === true ? 'OK  ' : 'FAIL'} ${target} ${row.ms}ms${row.ok === true ? '' : ` (${row.error ?? ''})`}`
  })
  return [`git: ${value.git ?? '未找到'}`, ...rows].join('\n')
}

/**
 * 组装工具返回值。
 *
 * 工具结果必须是无损 JSON：对象里的 `undefined` 键在 JSON.stringify 时会被丢掉，
 * 运行时据此判成「value is not lossless JSON」并整次调用失败——所以统一先过一遍
 * JSON 往返，顺便把 Date 之类也归一。
 */
function reply(ok, summary, data) {
  let clean = {}
  try {
    const round = data === undefined ? {} : JSON.parse(JSON.stringify(data))
    clean = typeof round === 'object' && round !== null && !Array.isArray(round) ? round : { value: round }
  } catch {
    clean = {}
  }
  return { ok, summary, data: clean }
}

/**
 * 构造工具定义。
 * @param {{store: any, git: any, api: any, opener: any}} deps
 */
export function githubWorkspaceTool(deps) {
  const { git, api, opener } = deps
  return {
    name: 'github_workspace',
    description:
      'GitHub 仓库即工作区：列出/打开/查看/拉取以 GitHub 仓库为来源的 DSH 工作区（工作区标题取仓库名），并自检国内网络各条加速链路。' +
      '不能提交或推送——那两个动作只在 GUI 面板里由用户手动触发。' +
      'Triggers: GitHub repo workspace, clone repo as workspace, pull latest, 工作区, 仓库, 拉取, 克隆不下来, 国内网络.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'status', 'open', 'pull', 'diagnose', 'repos'],
          description: 'list=已打开的工作区与状态；status=单个仓库状态；open=克隆并登记为工作区；pull=快进拉取；diagnose=git/网络链路自检；repos=列出 token 可见的 GitHub 仓库。',
        },
        input: { type: 'string', description: 'action=open 时的仓库地址：owner/repo、https://github.com/owner/repo 或 git@github.com:owner/repo.git。' },
        repo: { type: 'string', description: 'action=status/pull 时的 owner/repo（必须是 list 里出现过的）。' },
        query: { type: 'string', description: 'action=repos 时的过滤词（匹配仓库名与描述）。' },
      },
      required: ['action'],
    },
    output: {
      // 注意：register() 只接受标准 JSON Schema 子集（required 必须在对象层），
      // 不是 defineTool 那套「属性级 required」的描述格式。
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          data: { type: 'object', additionalProperties: true },
        },
        required: ['ok', 'summary', 'data'],
      },
      render: (_args, value) => text(value.summary ?? ''),
    },
    async execute(args) {
      const action = typeof args.action === 'string' ? args.action : ''
      try {
        if (action === 'list') {
          const rows = await opener.list()
          return reply(true, renderList(rows), { workspaces: rows })
        }
        if (action === 'status') {
          const value = await opener.status(args.repo)
          if (value.ok === false) return reply(false, `失败：${value.error ?? '未知错误'}`, value)
          return reply(
            true,
            `${value.fullName} | ${value.branch} | 改动 ${value.dirty} 待推 ${value.ahead} 待拉 ${value.behind} | HEAD ${value.head?.sha ?? ''} ${value.head?.subject ?? ''}`,
            value,
          )
        }
        if (action === 'open') {
          const value = await opener.open({ input: args.input ?? args.repo })
          if (value.ok !== true) {
            const failures = Array.isArray(value.failures) && value.failures.length > 0
              ? '；' + value.failures.map((item) => `${item.strategy}${item.mirror === undefined ? '' : `(${item.mirror})`}: ${item.error}`).join(' / ')
              : ''
            return reply(false, `打开失败：${value.error ?? '未知错误'}${failures}`, value)
          }
          return reply(
            true,
            `已打开 ${value.fullName} → 工作区「${value.title}」${value.cloned === true ? '（新克隆' + (value.strategy === '' ? '' : '，' + value.strategy) + '）' : '（复用本地目录）'}：${value.path}`,
            value,
          )
        }
        if (action === 'pull') {
          const value = await opener.pull(args.repo)
          if (value.ok !== true) {
            const failures = Array.isArray(value.failures) && value.failures.length > 0
              ? '；' + value.failures.map((item) => `${item.strategy}: ${item.error}`).join(' / ')
              : ''
            return reply(false, `拉取失败：${value.error ?? '未知错误'}${failures}${value.detail === undefined ? '' : '\n' + value.detail}`, value)
          }
          return reply(true, `${value.fullName}（${value.branch}）${value.upToDate === true ? '已是最新' : '已快进更新'}，策略 ${value.strategy}`, value)
        }
        if (action === 'diagnose') {
          const value = await git.diagnose()
          return reply(value.git !== null, renderDiagnose(value), value)
        }
        if (action === 'repos') {
          const repos = await api.listRepos()
          const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
          const filtered = query === ''
            ? repos
            : repos.filter((repo) => repo.fullName.toLowerCase().includes(query))
          const head = filtered.slice(0, 60)
          return reply(
            true,
            [`共 ${filtered.length} 个仓库（最多列 60 个）`, ...head.map((repo) => `${repo.fullName} | ${repo.private ? 'private' : 'public'} | ${repo.defaultBranch} | ${repo.updatedAt.slice(0, 10)}`)].join('\n'),
            { repos: head, total: filtered.length },
          )
        }
        return reply(false, `未知 action：${action || '(空)'}`, {})
      } catch (error) {
        return reply(false, `失败：${error instanceof Error ? error.message : String(error)}`, {})
      }
    },
  }
}

/**
 * dsh-github-workspaces — 浏览器半边。
 *
 * 两处挂载，都走 ctx.slots.inject（壳层声明了座位才注册，加载顺序无关）：
 * - sidebar.panellist：侧边栏的全局面板图标（order 50，排在 ssh 之后）
 * - main：键控主面板，key 与图标 id 相同，壳层据此切换
 *
 * 数据全部走同源 /api/dsh-github-workspaces；这个模块不做任何写文件动作，
 * 也不接管 document.body。所有失败只降级面板，不抛到壳层——插件 apply 抛错
 * 会把整个 GUI 的启动带崩。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-github-workspaces',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** 面板 id：侧边栏图标与 main 槽位共用。 */
    const PANEL_ID = 'github-workspaces'
    /** 宿主路由前缀。 */
    const API = '/api/dsh-github-workspaces'
    /** 客户端 locale 命名空间。 */
    const NS = 'dsh-github-workspaces'

    /** 界面文案（中文为默认，英文给 locale 用）。 */
    const DICTS = {
      zh: {
        'entry.label': 'GitHub 工作区',
        'page.title': 'GitHub 工作区',
        'page.subtitle': '每个 GitHub 仓库就是一个工作区，标题取仓库名',
        'action.refresh': '刷新',
        'action.diagnose': '网络自检',
        'action.save': '保存',
        'action.open': '打开',
        'action.pull': '拉取',
        'action.push': '推送',
        'action.rebase': '变基到远端',
        'action.merge': '合并远端',
        'action.continueIntegration': '继续',
        'action.abortIntegration': '中止整合',
        'action.switch': '切换',
        'action.deleteBranch': '删除',
        'action.createBranch': '新建并切换',
        'action.trackBranch': '检出',
        'action.checkUpdates': '检查更新',
        'action.pullAll': '全部拉取',
        'action.import': '导入',
        'action.probeProxy': '探测',
        'import.title': '或：导入浏览器下载的归档（没有 git 历史，只读快照）',
        'hint.branches': '切换 / 新建分支',
        'hint.newBranch': '新分支名（从当前 HEAD 建）',
        'hint.openPanel': '打开 GitHub 工作区面板',
        'action.commit': '提交并推送',
        'action.changes': '改动',
        'action.hideChanges': '收起改动',
        'action.commitSelected': '提交并推送',
        'action.reveal': '打开目录',
        'action.forget': '移除登记',
        'action.loadRepos': '加载我的仓库',
        'action.cancel': '取消',
        'action.close': '收起',
        'diag.preferred': '首选',
        'section.open': '打开仓库',
        'section.workspaces': '已打开的工作区',
        'section.settings': '设置',
        'section.diagnose': '网络自检结果',
        'hint.url': 'owner/repo，或 https://github.com/owner/repo，或 git@github.com:owner/repo.git',
        'hint.commit': '提交信息（留空用时间戳）',
        'label.token': 'GitHub Token',
        'label.cloneRoot': '克隆根目录',
        'label.mode': '网络策略',
        'label.mirror': '镜像前缀',
        'label.proxy': '本地代理',
        'label.apiBase': 'API 基址',
        'label.authorName': '提交作者名',
        'label.authorEmail': '提交邮箱',
        'label.shallow': '浅克隆（--depth 1）',
        'state.loading': '加载中…',
        'state.noGit': '未找到 git',
        'state.noWorkspaces': '还没有从 GitHub 打开过仓库。',
        'state.noToken': '未配置 token',
        'state.tokenEnv': 'token 来自环境变量',
        'state.tokenFile': 'token 已保存',
        'notice.opened': '已打开',
      },
      en: {
        'entry.label': 'GitHub Workspaces',
        'page.title': 'GitHub Workspaces',
        'page.subtitle': 'One workspace per GitHub repository, titled after the repo',
        'action.refresh': 'Refresh',
        'action.diagnose': 'Network check',
        'action.save': 'Save',
        'action.open': 'Open',
        'action.pull': 'Pull',
        'action.push': 'Push',
        'action.rebase': 'Rebase onto remote',
        'action.merge': 'Merge remote',
        'action.continueIntegration': 'Continue',
        'action.abortIntegration': 'Abort',
        'action.switch': 'Switch',
        'action.deleteBranch': 'Delete',
        'action.createBranch': 'Create & switch',
        'action.trackBranch': 'Check out',
        'action.checkUpdates': 'Check updates',
        'action.pullAll': 'Pull all',
        'action.import': 'Import',
        'action.probeProxy': 'Probe',
        'import.title': 'Or import an archive downloaded in your browser (no git history, read-only)',
        'hint.branches': 'Switch / create branch',
        'hint.newBranch': 'New branch name (from current HEAD)',
        'hint.openPanel': 'Open the GitHub workspaces panel',
        'action.commit': 'Commit & push',
        'action.changes': 'Changes',
        'action.hideChanges': 'Hide changes',
        'action.commitSelected': 'Commit & push',
        'action.reveal': 'Open folder',
        'action.forget': 'Unregister',
        'action.loadRepos': 'Load my repositories',
        'action.close': 'Hide',
        'section.open': 'Open a repository',
        'section.workspaces': 'Open workspaces',
        'section.settings': 'Settings',
        'section.diagnose': 'Network check',
        'hint.url': 'owner/repo, or https://github.com/owner/repo, or git@github.com:owner/repo.git',
        'hint.commit': 'Commit message (timestamp when empty)',
        'label.token': 'GitHub token',
        'label.cloneRoot': 'Clone root',
        'label.mode': 'Network strategy',
        'label.mirror': 'Mirror prefix',
        'label.proxy': 'Local proxy',
        'label.apiBase': 'API base',
        'label.authorName': 'Commit author',
        'label.authorEmail': 'Commit email',
        'label.shallow': 'Shallow clone (--depth 1)',
        'state.loading': 'Loading…',
        'state.noGit': 'git not found',
        'state.noWorkspaces': 'No repository opened from GitHub yet.',
        'state.noToken': 'no token',
        'state.tokenEnv': 'token from environment',
        'state.tokenFile': 'token saved',
        'notice.opened': 'Opened',
      },
    }

    /** 当前翻译函数，apply 里换成 locale 服务的绑定。 */
    let translate = (key) => key
    /** 客户端上下文，登出工作区跳转用。 */
    let clientCtx
    /** 取文案：locale 没有就退中文默认。 */
    function t(key, fallback) {
      try {
        const value = translate(key)
        return typeof value === 'string' && value !== '' && value !== key ? value : fallback
      } catch {
        return fallback
      }
    }

    /** 共用样式（全部用主题 token，跟随明暗）。 */
    const S = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        lineHeight: 1.5,
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '14px 18px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        flex: '0 0 auto',
      },
      headerText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
      title: { fontSize: 15, fontWeight: 600 },
      subtitle: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      body: {
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        padding: '16px 18px 32px',
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '12px 14px',
      },
      sectionTitle: {
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-secondary)',
        marginBottom: 8,
      },
      row: { display: 'flex', alignItems: 'center', gap: 8 },
      wrap: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
      input: {
        flex: 1,
        minWidth: 0,
        padding: '7px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        fontFamily: 'inherit',
        outline: 'none',
      },
      button: {
        padding: '6px 11px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12,
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      },
      buttonPrimary: {
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#ffffff',
      },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 7px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)',
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)',
      },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)',
        wordBreak: 'break-all',
      },
      banner: { padding: '8px 11px', borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap' },
      list: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8, maxHeight: 260, overflow: 'auto' },
      listRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      grow: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      field: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 },
      fieldLabel: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      details: { cursor: 'pointer', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
    }

    /** 一个操作失败的文案。 */
    function errorText(error) {
      if (error === null || error === undefined) return '未知错误'
      const detail = error.payload
      const parts = [error.message || String(error)]
      if (detail !== undefined && detail !== null) {
        if (Array.isArray(detail.failures) && detail.failures.length > 0) {
          parts.push(detail.failures.map((item) => `${item.strategy}${item.mirror === undefined ? '' : `(${item.mirror})`}: ${item.error}`).join('\n'))
        }
        if (typeof detail.detail === 'string' && detail.detail !== '') parts.push(detail.detail)
      }
      return parts.filter((part) => typeof part === 'string' && part !== '').join('\n')
    }

    /** 一次 API 调用；业务失败也抛，附带 payload 供展示细节。 */
    async function call(path, body) {
      const init = body === undefined
        ? { method: 'GET' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      const response = await fetch(path, init)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        const error = new Error(payload !== null && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`)
        error.payload = payload
        throw error
      }
      if (payload === null) throw new Error('响应不是 JSON')
      if (payload.ok === false) {
        const error = new Error(typeof payload.error === 'string' ? payload.error : '操作失败')
        error.payload = payload
        throw error
      }
      return payload
    }

    /**
     * 读一段 NDJSON 响应：逐帧回调，返回 result 帧的 payload。
     * @param {Response} response - fetch 的响应。
     * @param {Function} [onFrame] - 非 result 帧的回调。
     */
    async function readNdjson(response, onFrame) {
      if (!response.ok || response.body === null) {
        let text = ''
        try {
          text = await response.text()
        } catch {
          text = ''
        }
        let parsed = null
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = null
        }
        const error = new Error(parsed !== null && typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.status}`)
        error.payload = parsed
        throw error
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let final = null
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim() === '') continue
          let frame = null
          try {
            frame = JSON.parse(line)
          } catch {
            continue
          }
          if (frame.type === 'result') final = frame
          else if (typeof onFrame === 'function') onFrame(frame)
        }
      }
      if (final === null) throw new Error('流式响应没有给出结果帧（连接可能被中断）')
      if (final.ok === false || (final.payload !== undefined && final.payload !== null && final.payload.ok === false)) {
        const payload = final.payload ?? {}
        const error = new Error(typeof payload.error === 'string' ? payload.error : '操作失败')
        error.payload = payload
        throw error
      }
      return final.payload ?? { ok: true }
    }

    /**
     * 一次 NDJSON 流式调用（克隆/拉取/整合/推送/提交）。
     * @param {string} path - 接口路径。
     * @param {object} body - 请求体。
     * @param {{onFrame?: Function, signal?: AbortSignal}} [options]
     */
    async function streamCall(path, body, options = {}) {
      const { onFrame, signal } = options
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal,
      })
      return readNdjson(response, onFrame)
    }

    /**
     * 把浏览器里选的归档文件 POST 给宿主（归档导入）。
     * @param {string} path - 带 query 的导入地址。
     * @param {File} file - 文件对象。
     * @param {{onFrame?: Function, signal?: AbortSignal}} [options]
     */
    async function streamUpload(path, file, options = {}) {
      const { onFrame, signal } = options
      const response = await fetch(path, { method: 'POST', body: file, signal })
      return readNdjson(response, onFrame)
    }

    /** 从归档文件名猜仓库名（服务端也会校验，这里只是预填）。 */
    function guessRepoFromFile(name) {
      const base = String(name ?? '').replace(/\.(zip|tar\.gz|tgz|tar)$/i, '')
      const matched = /^(.+)-(main|master|trunk|develop|dev|HEAD)$/i.exec(base)
      if (matched !== null) return matched[1]
      const dash = base.lastIndexOf('-')
      return dash > 0 ? base.slice(0, dash) : base
    }

    /** 打开后把 GUI 切到那个工作区（服务不可用就静默放弃）。 */
    function jumpToWorkspace(workspaceId) {
      if (typeof workspaceId !== 'string' || workspaceId === '') return
      try {
        const ui = typeof clientCtx?.get === 'function' ? clientCtx.get('uiWorkspace') : undefined
        if (ui !== null && ui !== undefined && typeof ui.openWorkspace === 'function') {
          const pending = ui.openWorkspace(workspaceId)
          if (pending !== null && typeof pending.catch === 'function') pending.catch(() => {})
        }
      } catch {
        /* 切不过去也不影响已登记的工作区 */
      }
    }

    /** 按钮。 */
    function Button({ children, onClick, primary, disabled, title }) {
      const isDisabled = disabled === true
      return h('button', {
        type: 'button',
        title: title === undefined ? undefined : title,
        disabled: isDisabled,
        onClick: isDisabled ? undefined : onClick,
        style: { ...S.button, ...(primary === true ? S.buttonPrimary : null), opacity: isDisabled ? 0.5 : 1, cursor: isDisabled ? 'default' : 'pointer' },
      }, children)
    }

    /** 小标签。 */
    function Chip({ children, tone }) {
      const color = tone === 'ok'
        ? 'var(--dsw-alias-state-success-primary)'
        : tone === 'warn'
          ? 'var(--dsw-alias-state-warn-primary)'
          : tone === 'error'
            ? 'var(--dsw-alias-state-error-primary)'
            : 'var(--dsw-alias-label-secondary)'
      return h('span', { style: { ...S.chip, color } }, children)
    }

    /** 表单一行。 */
    function Field({ label, children }) {
      return h('div', { style: S.field }, h('div', { style: S.fieldLabel }, label), children)
    }

    /** 输入框。 */
    function Input({ value, onChange, placeholder, type, onKeyDown }) {
      return h('input', {
        value,
        type: type === undefined ? 'text' : type,
        placeholder: placeholder === undefined ? undefined : placeholder,
        spellCheck: false,
        onChange: (event) => onChange(event.target.value),
        onKeyDown: onKeyDown === undefined ? undefined : (event) => { if (event.key === 'Enter') onKeyDown() },
        style: S.input,
      })
    }

    /** 网络策略下拉。 */
    function Select({ value, onChange, options }) {
      return h('select', {
        value,
        onChange: (event) => onChange(event.target.value),
        style: { ...S.input, flex: '0 0 auto', minWidth: 140 },
      }, options.map((option) => h('option', { key: option, value: option }, option)))
    }

    /** 已打开工作区的卡片：状态 + 分支 + 改动勾选 + 单文件 diff 预览。 */
    function WorkspaceCard({ row, busy, onPull, onPush, onIntegrate, onAbort, onContinue, onCommit, onCheckout, onDeleteBranch, onReveal, onForget }) {
      const [branchOpen, setBranchOpen] = useState(false)
      const [branches, setBranches] = useState(null)
      const [newBranch, setNewBranch] = useState('')
      const [branchBusy, setBranchBusy] = useState('')
      const [branchProblem, setBranchProblem] = useState('')
      const [open, setOpen] = useState(false)
      const [files, setFiles] = useState(null)
      const [selected, setSelected] = useState({})
      const [diff, setDiff] = useState(null)
      const [message, setMessage] = useState('')
      const [innerBusy, setInnerBusy] = useState('')
      const [problem, setProblem] = useState('')

      const flags = []
      if (row.exists === false) flags.push({ text: '目录缺失', tone: 'error' })
      if (row.snapshot === true) flags.push({ text: '无 git 历史', tone: 'warn' })
      if (row.dirty > 0) flags.push({ text: `${row.dirty} 个改动`, tone: 'warn' })
      if (row.ahead > 0) flags.push({ text: `待推 ${row.ahead}`, tone: 'warn' })
      if (row.behind > 0) flags.push({ text: `待拉 ${row.behind}`, tone: 'ok' })
      if (row.tracking === false && row.snapshot !== true) flags.push({ text: '无上游', tone: undefined })
      if (flags.length === 0 && row.exists !== false) flags.push({ text: '干净', tone: 'ok' })

      /** 拉一次改动列表，默认全选并预览第一个文件。 */
      const load = async () => {
        setInnerBusy('list')
        setProblem('')
        try {
          const payload = await call(`${API}/changes`, { repo: row.fullName })
          const list = payload.files ?? []
          setFiles(list)
          const next = {}
          for (const file of list) next[file.path] = true
          setSelected(next)
          if (list.length > 0) void showDiff(list[0].path)
        } catch (error) {
          setProblem(errorText(error))
        } finally {
          setInnerBusy('')
        }
      }

      /** 加载单个文件的 diff。 */
      const showDiff = async (filePath) => {
        setDiff({ path: filePath, text: '加载中…', kind: '' })
        try {
          const payload = await call(`${API}/diff`, { repo: row.fullName, path: filePath })
          setDiff({ path: payload.path ?? filePath, text: payload.text ?? '', kind: payload.kind })
        } catch (error) {
          setDiff({ path: filePath, text: errorText(error), kind: 'error' })
        }
      }

      /** 拉一次分支列表。 */
      const loadBranches = async () => {
        setBranchBusy('list')
        setBranchProblem('')
        try {
          setBranches(await call(`${API}/branches`, { repo: row.fullName }))
        } catch (error) {
          setBranchProblem(errorText(error))
        } finally {
          setBranchBusy('')
        }
      }

      /** 展开/收起分支面板。 */
      const toggleBranches = () => {
        if (branchOpen) {
          setBranchOpen(false)
          return
        }
        setBranchOpen(true)
        void loadBranches()
      }

      // 切换分支后 row.branch 会变，面板开着就重载一次列表
      useEffect(() => {
        if (branchOpen) void loadBranches()
      }, [row.branch])

      const toggle = () => {
        if (open) {
          setOpen(false)
          return
        }
        setOpen(true)
        void load()
      }

      const list = files ?? []
      const chosen = list.filter((file) => selected[file.path] === true).map((file) => file.path)
      const allChosen = list.length > 0 && chosen.length === list.length
      const toggleAll = () => {
        const next = {}
        for (const file of list) next[file.path] = !allChosen
        setSelected(next)
      }

      return h('div', { style: { ...S.card, display: 'flex', flexDirection: 'column', gap: 8 } }, [
        h('div', { key: 'head', style: S.row }, [
          h('div', { key: 'name', style: { ...S.grow, display: 'flex', alignItems: 'center', gap: 8 } }, [
            h('strong', { key: 't', style: { fontSize: 13 } }, row.title),
            // 分支入口：点名当前分支（游离头时明确警告），点开就是分支面板
            h('span', {
              key: 'b',
              title: row.snapshot === true ? '从归档导入的只读快照：没有 git 历史' : t('hint.branches', '切换 / 新建分支'),
              onClick: row.snapshot === true ? undefined : toggleBranches,
              style: {
                ...S.chip,
                cursor: row.snapshot === true ? 'default' : 'pointer',
                color: row.snapshot === true || row.branch === ''
                  ? 'var(--dsw-alias-state-warn-primary)'
                  : 'var(--dsw-alias-label-secondary)',
              },
            }, row.snapshot === true ? '只读快照' : `${row.branch === '' ? '游离 HEAD' : row.branch} ▾`),
            ...flags.map((flag, index) => h(Chip, { key: `f${index}`, tone: flag.tone }, flag.text)),
          ]),
        ]),
        h('div', { key: 'path', style: S.mono }, row.path),
        row.head !== undefined && row.head !== null && typeof row.head.subject === 'string' && row.head.subject !== ''
          ? h('div', { key: 'headline', style: S.mono }, `${row.head.sha} · ${row.head.date} · ${row.head.subject}`)
          : null,
        h('div', { key: 'ops', style: S.row }, [
          h(Button, { key: 'pull', onClick: () => onPull(row), disabled: busy || row.snapshot === true, primary: row.behind > 0 }, busy ? '…' : t('action.pull', '拉取')),
          h(Button, { key: 'push', onClick: () => onPush(row), disabled: busy || row.snapshot === true || !(row.ahead > 0) }, `${t('action.push', '推送')} ${row.ahead > 0 ? row.ahead : ''}`.trim()),
          h(Button, {
            key: 'changes',
            onClick: toggle,
            disabled: busy || row.exists === false || row.snapshot === true,
          }, open ? t('action.hideChanges', '收起改动') : `${t('action.changes', '改动')} ${row.dirty > 0 ? row.dirty : ''}`.trim()),
          h(Button, { key: 'reveal', onClick: () => onReveal(row), disabled: busy }, t('action.reveal', '打开目录')),
          h(Button, { key: 'forget', onClick: () => onForget(row), disabled: busy }, t('action.forget', '移除登记')),
        ]),

        // 分支面板
        branchOpen ? h('div', {
          key: 'branchPanel',
          style: { display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 8 },
        }, [
          branchProblem === '' ? null : h('div', { key: 'p', style: { ...S.banner, color: 'var(--dsw-alias-state-error-primary)' } }, branchProblem),
          h('div', { key: 'newRow', style: S.row }, [
            h(Input, { key: 'n', value: newBranch, onChange: setNewBranch, placeholder: t('hint.newBranch', '新分支名（从当前 HEAD 建）') }),
            h(Button, {
              key: 'c',
              onClick: () => { const name = newBranch.trim(); if (name !== '') { onCheckout(row, name, true); setNewBranch('') } },
              disabled: busy || branchBusy !== '' || newBranch.trim() === '',
            }, t('action.createBranch', '新建并切换')),
          ]),
          branchBusy === 'list'
            ? h('div', { key: 'loading', style: S.mono }, t('state.loading', '加载中…'))
            : null,
          branches === null || branches.local.length === 0
            ? null
            : h('div', { key: 'local', style: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 180, overflow: 'auto' } }, [
              h('div', { key: 'lt', style: S.fieldLabel }, `本地分支（${branches.local.length}）`),
              ...branches.local.map((item) => h('div', { key: item.name, style: { ...S.row, gap: 6 } }, [
                h('span', { key: 'n', style: { ...S.grow, fontWeight: item.current === true ? 600 : 400 } }, item.current === true ? `${item.name} · 当前` : item.name),
                item.track === '' ? null : h('span', { key: 't', style: S.mono }, item.track),
                h(Button, { key: 's', onClick: () => onCheckout(row, item.name, false), disabled: busy || branchBusy !== '' || item.current === true }, t('action.switch', '切换')),
                item.current === true ? null : h(Button, { key: 'd', onClick: () => onDeleteBranch(row, item.name), disabled: busy || branchBusy !== '' }, t('action.deleteBranch', '删除')),
              ])),
            ]),
          branches === null || branches.remote.length === 0
            ? null
            : h('div', { key: 'remote', style: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 140, overflow: 'auto' } }, [
              h('div', { key: 'rt', style: S.fieldLabel }, `远端分支（${branches.remote.length}）`),
              ...branches.remote.map((item) => h('div', { key: item.name, style: { ...S.row, gap: 6 } }, [
                h('span', { key: 'n', style: S.grow }, item.name),
                h(Button, {
                  key: 's',
                  onClick: () => onCheckout(row, item.name, false),
                  disabled: busy || branchBusy !== '' || item.hasLocal === true,
                  title: item.hasLocal === true ? '本地已有同名分支' : '检出为本地跟踪分支',
                }, t('action.trackBranch', '检出')),
              ])),
            ]),
        ]) : null,

        // 停在 rebase/merge 中间态：给「继续」和「中止」两条出路
        row.state !== undefined && row.state !== 'clean'
          ? h('div', {
            key: 'conflict',
            style: { ...S.banner, background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-state-warn-primary)', color: 'var(--dsw-alias-state-warn-primary)' },
          }, [
            h('div', { key: 't' }, `仓库停在${row.state === 'rebasing' ? '变基' : '合并'}中间态${(row.conflicts ?? []).length > 0 ? `，还有 ${row.conflicts.length} 个冲突文件：` : ''}`),
            (row.conflicts ?? []).length > 0 ? h('div', { key: 'l', style: { ...S.mono, whiteSpace: 'pre-wrap' } }, row.conflicts.join('\n')) : null,
            h('div', { key: 'b', style: { ...S.row, marginTop: 6 } }, [
              h(Button, { key: 'c', onClick: () => onContinue(row), disabled: busy, primary: true }, t('action.continueIntegration', '继续')),
              h(Button, { key: 'a', onClick: () => onAbort(row), disabled: busy }, t('action.abortIntegration', '中止整合')),
            ]),
          ])
          : null,

        // 本地与远端都往前走了：让用户显式选变基还是合并，绝不自动
        row.state === 'clean' && row.ahead > 0 && row.behind > 0
          ? h('div', {
            key: 'diverged',
            style: { ...S.banner, background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-state-warn-primary)', color: 'var(--dsw-alias-state-warn-primary)' },
          }, [
            h('div', { key: 't' }, `与远端分叉：本地领先 ${row.ahead}、落后 ${row.behind}`),
            h('div', { key: 'b', style: { ...S.row, marginTop: 6 } }, [
              h(Button, { key: 'r', onClick: () => onIntegrate(row, 'rebase'), disabled: busy, primary: true }, t('action.rebase', '变基到远端')),
              h(Button, { key: 'm', onClick: () => onIntegrate(row, 'merge'), disabled: busy }, t('action.merge', '合并远端')),
            ]),
          ])
          : null,

        open ? h('div', {
          key: 'panel',
          style: { display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 8 },
        }, [
          problem === '' ? null : h('div', { key: 'p', style: { ...S.banner, color: 'var(--dsw-alias-state-error-primary)' } }, problem),
          innerBusy === 'list'
            ? h('div', { key: 'loading', style: S.mono }, t('state.loading', '加载中…'))
            : list.length === 0
              ? h('div', { key: 'empty', style: S.mono }, '没有未提交的改动')
              : h('div', { key: 'files', style: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 220, overflow: 'auto' } }, [
                h('div', { key: 'all', style: { ...S.row, gap: 6 } }, [
                  h('input', { key: 'c', type: 'checkbox', checked: allChosen, onChange: toggleAll }),
                  h('span', { key: 'l', style: S.fieldLabel }, `全选 · 已选 ${chosen.length}/${list.length}`),
                ]),
                ...list.map((file) => h('div', { key: file.path, style: { ...S.row, gap: 6, padding: '2px 0' } }, [
                  h('input', {
                    key: 'c',
                    type: 'checkbox',
                    checked: selected[file.path] === true,
                    onChange: () => setSelected({ ...selected, [file.path]: selected[file.path] !== true }),
                  }),
                  h(Chip, { key: 's', tone: file.untracked === true ? 'warn' : undefined }, file.label),
                  h('span', {
                    key: 'p',
                    style: { ...S.grow, cursor: 'pointer', textDecoration: diff !== null && diff.path === file.path ? 'underline' : 'none' },
                    onClick: () => showDiff(file.path),
                  }, file.renamedFrom === undefined ? file.path : `${file.renamedFrom} → ${file.path}`),
                ])),
              ]),
          diff === null
            ? null
            : h('pre', {
              key: 'diff',
              style: {
                margin: 0,
                padding: 10,
                borderRadius: 8,
                background: 'var(--dsw-alias-bg-layer-2)',
                color: 'var(--dsw-alias-label-secondary)',
                maxHeight: 300,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: 11,
              },
            }, diff.text === '' ? '（无差异内容）' : diff.text),
          h('div', { key: 'commit', style: S.row }, [
            h(Input, { key: 'm', value: message, onChange: setMessage, placeholder: t('hint.commit', '提交信息（留空用时间戳）') }),
            h(Button, {
              key: 'go',
              primary: true,
              disabled: busy || chosen.length === 0,
              onClick: () => onCommit(row, message, chosen),
            }, `${t('action.commitSelected', '提交并推送')} ${chosen.length} 个`),
          ]),
        ]) : null,
      ])
    }

    /** 设置卡。 */
    function SettingsCard({ draft, settings, busy, proxies, onChange, onSave, onProbe }) {
      const update = (patch) => onChange({ ...draft, ...patch })
      const updateNetwork = (patch) => onChange({ ...draft, network: { ...draft.network, ...patch } })
      const updateAuthor = (patch) => onChange({ ...draft, author: { ...draft.author, ...patch } })
      return h('div', { style: { ...S.card, display: 'flex', flexDirection: 'column' } }, [
        h('div', { key: 't', style: S.sectionTitle }, t('section.settings', '设置')),
        h('div', { key: 'token', style: S.field }, [
          h('div', { key: 'l', style: S.fieldLabel }, `${t('label.token', 'GitHub Token')} · ${settings.hasToken ? (settings.tokenSource === 'env' ? t('state.tokenEnv', 'token 来自环境变量') : t('state.tokenFile', 'token 已保存')) : t('state.noToken', '未配置 token')}`),
          h(Input, { key: 'i', value: draft.token, type: 'password', placeholder: 'ghp_… / github_pat_…', onChange: (value) => update({ token: value }) }),
        ]),
        h(Field, { key: 'root', label: t('label.cloneRoot', '克隆根目录') },
          h(Input, { value: draft.cloneRoot, onChange: (value) => update({ cloneRoot: value }) })),
        h('div', { key: 'net', style: S.row }, [
          h('div', { key: 'm', style: { flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 4 } }, [
            h('div', { key: 'l', style: S.fieldLabel }, t('label.mode', '网络策略')),
            h(Select, {
              key: 's',
              value: draft.network.mode,
              onChange: (value) => updateNetwork({ mode: value }),
              options: ['auto', 'direct', 'mirror', 'proxy', 'ssh443'],
            }),
          ]),
          h('div', { key: 'mirror', style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 } }, [
            h('div', { key: 'l', style: S.fieldLabel }, t('label.mirror', '镜像前缀')),
            h(Input, { key: 'i', value: draft.network.mirror, onChange: (value) => updateNetwork({ mirror: value }) }),
          ]),
        ]),
        h('div', { key: 'proxyRow', style: S.row }, [
          h('div', { key: 'p', style: { flex: 1, minWidth: 0 } },
            h(Field, { label: t('label.proxy', '本地代理（如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080）') },
              h(Input, { value: draft.network.proxy, onChange: (value) => updateNetwork({ proxy: value }) }))),
          h('div', { key: 'b', style: { flex: '0 0 auto', paddingTop: 14 } }, [
            h(Button, { key: 'probe', onClick: () => onProbe(), disabled: busy }, t('action.probeProxy', '探测')),
          ]),
        ]),
        proxies === null
          ? null
          : h('div', { key: 'proxies', style: { ...S.wrap, marginBottom: 10 } }, proxies.length === 0
            ? [h('span', { key: 'none', style: S.mono }, '没有发现本地代理端口')]
            : proxies.map((item) => h('button', {
              key: item.port,
              type: 'button',
              onClick: () => updateNetwork({ proxy: `${item.scheme}://127.0.0.1:${item.port}` }),
              style: { ...S.chip, cursor: 'pointer', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' },
            }, `${item.kind} · 127.0.0.1:${item.port}`))),
        h(Field, { key: 'api', label: t('label.apiBase', 'API 基址') },
          h(Input, { value: draft.network.apiBase, onChange: (value) => updateNetwork({ apiBase: value }) })),
        h('div', { key: 'author', style: S.row }, [
          h('div', { key: 'n', style: { flex: 1, minWidth: 0 } }, h(Field, { label: t('label.authorName', '提交作者名') }, h(Input, { value: draft.author.name, onChange: (value) => updateAuthor({ name: value }) }))),
          h('div', { key: 'e', style: { flex: 1, minWidth: 0 } }, h(Field, { label: t('label.authorEmail', '提交邮箱') }, h(Input, { value: draft.author.email, onChange: (value) => updateAuthor({ email: value }) }))),
        ]),
        h('div', { key: 'foot', style: S.row }, [
          h(Button, { key: 'save', onClick: () => onSave(draft), disabled: busy, primary: true }, t('action.save', '保存')),
          h('span', { key: 'file', style: { ...S.mono, flex: 1 } }, settings.settingsFile),
        ]),
      ])
    }

    /** 主面板。 */
    function Panel() {
      const [state, setState] = useState(null)
      const [draft, setDraft] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState('')
      const [repos, setRepos] = useState(null)
      const [repoQuery, setRepoQuery] = useState('')
      const [urlInput, setUrlInput] = useState('')
      const [diag, setDiag] = useState(null)
      const [diagOpen, setDiagOpen] = useState(false)
      /** 归档导入：选中的文件与目标 owner/repo。 */
      const [importFile, setImportFile] = useState(null)
      const [importRepo, setImportRepo] = useState('')
      /** 探测到的本地代理候选。 */
      const [proxies, setProxies] = useState(null)
      /** 正在跑的流式操作（克隆/拉取）的阶段与百分比；null 表示没有。 */
      const [stage, setStage] = useState(null)
      /** 当前可取消操作的 AbortController。 */
      const abortRef = useRef(null)

      /** 取消正在进行的克隆/拉取：abort 会让宿主杀掉 git 子进程。 */
      const cancel = useCallback(() => {
        const controller = abortRef.current
        if (controller !== null && controller !== undefined) controller.abort()
      }, [])

      const refresh = useCallback(async () => {
        setBusy('load')
        setError('')
        try {
          const payload = await call(`${API}/state`)
          setState(payload)
          const settings = payload.settings
          setDraft({
            token: '',
            cloneRoot: settings.cloneRoot,
            network: { ...settings.network },
            author: { ...settings.author },
            clone: { ...settings.clone },
          })
        } catch (problem) {
          setError(errorText(problem))
        } finally {
          setBusy('')
        }
      }, [])

      useEffect(() => {
        void refresh()
      }, [refresh])

      const run = useCallback(async (key, action) => {
        setBusy(key)
        setError('')
        setNotice('')
        try {
          await action()
        } catch (problem) {
          const aborted = problem !== null && problem !== undefined && (problem.name === 'AbortError' || /已取消|cancel/i.test(String(problem.message ?? '')))
          if (aborted) setNotice('已取消')
          else setError(errorText(problem))
        } finally {
          setBusy('')
        }
      }, [])

      const openRepo = (input) => run('open', async () => {
        const controller = new AbortController()
        abortRef.current = controller
        setStage({ text: '准备克隆…', percent: null })
        try {
          const payload = await streamCall(`${API}/open`, { input }, {
            signal: controller.signal,
            onFrame: (frame) => {
              if (frame.type === 'stage') setStage({ text: frame.text, percent: null })
              else if (frame.type === 'progress') setStage((previous) => ({ text: previous === null ? "" : previous.text, percent: frame.percent }))
            },
          })
          setUrlInput('')
          setNotice(`${t('notice.opened', '已打开')} ${payload.fullName} → ${payload.title}`)
          await refresh()
          jumpToWorkspace(payload.workspaceId)
        } finally {
          abortRef.current = null
          setStage(null)
        }
      })

      const pull = (row) => run(`pull:${row.fullName}`, async () => {
        const controller = new AbortController()
        abortRef.current = controller
        setStage({ text: `拉取 ${row.fullName}…`, percent: null })
        try {
          const payload = await streamCall(`${API}/pull`, { repo: row.fullName }, {
            signal: controller.signal,
            onFrame: (frame) => {
              if (frame.type === 'stage') setStage({ text: frame.text, percent: null })
              else if (frame.type === 'progress') setStage((previous) => ({ text: previous === null ? "" : previous.text, percent: frame.percent }))
            },
          })
          setNotice(`${row.fullName}：${payload.upToDate === true ? '已是最新' : '已快进更新'}（${payload.strategy}）`)
          await refresh()
        } finally {
          abortRef.current = null
          setStage(null)
        }
      })

      const push = (row) => run(`push:${row.fullName}`, async () => {
        const controller = new AbortController()
        abortRef.current = controller
        setStage({ text: `推送 ${row.fullName}…`, percent: null })
        try {
          const payload = await streamCall(`${API}/push`, { repo: row.fullName }, {
            signal: controller.signal,
            onFrame: (frame) => {
              if (frame.type === 'stage') setStage({ text: frame.text, percent: null })
            },
          })
          setNotice(`${row.fullName}：已推送（${payload.strategy ?? ''}）`)
          await refresh()
        } finally {
          abortRef.current = null
          setStage(null)
        }
      })

      const integrate = (row, mode) => run(`integrate:${row.fullName}`, async () => {
        const controller = new AbortController()
        abortRef.current = controller
        setStage({ text: mode === 'rebase' ? '变基到远端…' : '合并远端…', percent: null })
        try {
          const payload = await streamCall(`${API}/integrate`, { repo: row.fullName, mode }, {
            signal: controller.signal,
            onFrame: (frame) => {
              if (frame.type === 'stage') setStage({ text: frame.text, percent: null })
            },
          })
          setNotice(`${row.fullName}：${payload.upToDate === true ? '已是最新' : `已${mode === 'rebase' ? '变基' : '合并'}到远端，待推 ${payload.ahead ?? 0} 个提交`}`)
          await refresh()
        } finally {
          abortRef.current = null
          setStage(null)
        }
      })

      /** 中止停在中间态的变基/合并。 */
      const abortInt = (row) => run(`abort:${row.fullName}`, async () => {
        await call(`${API}/integration-abort`, { repo: row.fullName })
        setNotice(`${row.fullName}：已中止，回到整合前的状态`)
        await refresh()
      })

      /** 冲突解决之后继续。 */
      const continueInt = (row) => run(`continue:${row.fullName}`, async () => {
        const payload = await call(`${API}/integration-continue`, { repo: row.fullName })
        setNotice(`${row.fullName}：已继续（当前状态 ${payload.state ?? 'clean'}）`)
        await refresh()
      })

      /** 检查更新：对所有仓库 fetch（不合并），刷新角标。 */
      const checkUpdates = () => run('check', async () => {
        const controller = new AbortController()
        abortRef.current = controller
        setStage({ text: '检查更新…', percent: null })
        try {
          const payload = await streamCall(`${API}/check-updates`, {}, {
            signal: controller.signal,
            onFrame: (frame) => {
              if (frame.type === 'stage') setStage({ text: frame.text, percent: null })
            },
          })
          const parts = [`已检查 ${payload.total} 个仓库`]
          parts.push(payload.behindRepos > 0 ? `${payload.behindRepos} 个落后远端` : '都是最新的')
          if (payload.diverged.length > 0) parts.push(`${payload.diverged.length} 个已分叉`)
          if (payload.failed.length > 0) parts.push(`${payload.failed.length} 个失败`)
          setNotice(parts.join('，'))
          await refresh()
        } finally {
          abortRef.current = null
          setStage(null)
        }
      })

      /** 全部拉取：逐个快进，分叉的不动。 */
      const pullAll = () => run('pullAll', async () => {
        const controller = new AbortController()
        abortRef.current = controller
        setStage({ text: '全部拉取…', percent: null })
        try {
          const payload = await streamCall(`${API}/pull-all`, {}, {
            signal: controller.signal,
            onFrame: (frame) => {
              if (frame.type === 'stage') setStage({ text: frame.text, percent: null })
            },
          })
          const parts = [`更新 ${payload.pulled} 个`, `已最新 ${payload.upToDate} 个`]
          if (payload.diverged.length > 0) parts.push(`${payload.diverged.length} 个分叉需处理`)
          if (payload.failed.length > 0) parts.push(`${payload.failed.length} 个失败`)
          setNotice(`全部拉取：${parts.join('，')}`)
          await refresh()
        } finally {
          abortRef.current = null
          setStage(null)
        }
      })

      /** 归档导入：把浏览器下载的 zip 交给宿主解压并登记为只读快照。 */
      const importArchive = (file, repoName) => run('import', async () => {
        const controller = new AbortController()
        abortRef.current = controller
        setStage({ text: '接收归档…', percent: null })
        try {
          const query = `?repo=${encodeURIComponent(repoName)}&name=${encodeURIComponent(file.name)}`
          const payload = await streamUpload(`${API}/import${query}`, file, {
            signal: controller.signal,
            onFrame: (frame) => {
              if (frame.type === 'stage') setStage({ text: frame.text, percent: null })
            },
          })
          setNotice(`已导入 ${payload.fullName}（只读快照，${payload.entries ?? 0} 个顶层条目）`)
          setImportFile(null)
          setImportRepo('')
          await refresh()
          jumpToWorkspace(payload.workspaceId)
        } finally {
          abortRef.current = null
          setStage(null)
        }
      })

      /** 探测本地代理端口（只连 127.0.0.1）。 */
      const probeProxy = () => run('probe', async () => {
        const payload = await call(`${API}/proxy-probe`)
        const list = payload.candidates ?? []
        setProxies(list)
        setNotice(list.length === 0 ? '没有探测到本地代理端口' : `探测到 ${list.length} 个本地端口，点一下即可填入`)
      })

      /** 切换分支 / 从当前 HEAD 新建分支 / 检出远端分支。 */
      const checkout = (row, name, create) => run(`checkout:${row.fullName}`, async () => {
        await call(`${API}/checkout`, { repo: row.fullName, name, create: create === true })
        setNotice(`${row.fullName}：已切换到 ${name}`)
        await refresh()
      })

      /** 删除本地分支（宿主只做安全删除）。 */
      const deleteBranch = (row, name) => run(`branch-delete:${row.fullName}`, async () => {
        await call(`${API}/branch-delete`, { repo: row.fullName, name })
        setNotice(`${row.fullName}：已删除本地分支 ${name}`)
        await refresh()
      })

      const commit = (row, message, paths) => run(`commit:${row.fullName}`, async () => {
        const controller = new AbortController()
        abortRef.current = controller
        const count = Array.isArray(paths) ? paths.length : 0
        setStage({ text: `准备提交 ${count} 个文件…`, percent: null })
        try {
          const payload = await streamCall(`${API}/commit`, { repo: row.fullName, message, paths }, {
            signal: controller.signal,
            onFrame: (frame) => {
              if (frame.type === 'stage') setStage({ text: frame.text, percent: null })
            },
          })
          setNotice(`${row.fullName}：已提交 ${payload.files ?? count} 个文件并推送（${payload.branch}）`)
          await refresh()
        } finally {
          abortRef.current = null
          setStage(null)
        }
      })

      const reveal = (row) => run(`reveal:${row.fullName}`, async () => {
        await call(`${API}/reveal`, { repo: row.fullName })
      })

      const forget = (row) => run(`forget:${row.fullName}`, async () => {
        await call(`${API}/forget`, { repo: row.fullName })
        setNotice(`${row.fullName}：已移除工作区登记（磁盘文件保留）`)
        await refresh()
      })

      const loadRepos = () => run('repos', async () => {
        const payload = await call(`${API}/repos`, {})
        setRepos(payload.repos)
        setNotice(`已加载 ${payload.repos.length} 个仓库`)
      })

      const diagnose = () => run('diagnose', async () => {
        const payload = await call(`${API}/diagnose`, {})
        setDiag(payload)
        setDiagOpen(true)
        if (payload.identity !== null && payload.identity !== undefined && draft !== null && draft.author.email === '') {
          setDraft({ ...draft, author: { name: payload.identity.name, email: payload.identity.email } })
        }
      })

      const save = (next) => run('save', async () => {
        const patch = {
          cloneRoot: next.cloneRoot,
          network: next.network,
          author: next.author,
          clone: next.clone,
        }
        if (next.token !== '') patch.token = next.token
        await call(`${API}/settings`, patch)
        setNotice('设置已保存')
        await refresh()
      })

      const settings = state === null ? null : state.settings
      const env = state === null ? null : state.env
      const workspaces = state === null ? [] : state.workspaces

      const filteredRepos = repos === null
        ? null
        : repoQuery.trim() === ''
          ? repos
          : repos.filter((repo) => repo.fullName.toLowerCase().includes(repoQuery.trim().toLowerCase()))

      return h('div', { style: S.page, 'data-dsh-plugin': 'github-workspaces' }, [
        h('div', { key: 'header', style: S.header }, [
          h('div', { key: 'text', style: { ...S.headerText, flex: 1 } }, [
            h('div', { key: 't', style: S.title }, t('page.title', 'GitHub 工作区')),
            h('div', { key: 's', style: S.subtitle }, t('page.subtitle', '每个 GitHub 仓库就是一个工作区，标题取仓库名')),
          ]),
          h(Button, { key: 'diag', onClick: diagnose, disabled: busy !== '' }, t('action.diagnose', '网络自检')),
          stage === null ? null : h(Button, { key: 'cancel', onClick: cancel }, t('action.cancel', '取消')),
          h(Button, { key: 'refresh', onClick: refresh, disabled: busy !== '' }, busy === 'load' ? t('state.loading', '加载中…') : t('action.refresh', '刷新')),
        ]),

        h('div', { key: 'body', style: S.body }, [
          stage === null
            ? null
            : h('div', {
              key: 'stage',
              style: { ...S.banner, background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-secondary)' },
            }, [
              h('div', { key: 't', style: { display: 'flex', justifyContent: 'space-between', gap: 8 } }, [
                h('span', { key: 'x' }, stage.text ?? ''),
                h('span', { key: 'p', style: S.mono }, stage.percent === null || stage.percent === undefined ? '' : `${stage.percent}%`),
              ]),
              h('div', { key: 'bar', style: { marginTop: 6, height: 4, borderRadius: 2, background: 'var(--dsw-alias-border-l1)', overflow: 'hidden' } }, [
                h('div', {
                  key: 'fill',
                  style: {
                    height: '100%',
                    width: `${stage.percent === null || stage.percent === undefined ? 15 : stage.percent}%`,
                    background: 'var(--dsw-alias-brand-primary)',
                    transition: 'width 200ms ease',
                  },
                }),
              ]),
            ]),
          error === '' ? null : h('div', {
            key: 'error',
            style: { ...S.banner, background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' },
          }, error),
          notice === '' ? null : h('div', {
            key: 'notice',
            style: { ...S.banner, background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-secondary)' },
          }, notice),

          env === null ? null : h('div', { key: 'env', style: S.wrap }, [
            h(Chip, { key: 'git', tone: env.git === null ? 'error' : 'ok' }, env.git === null ? t('state.noGit', '未找到 git') : `git ${env.git}`),
            h(Chip, { key: 'token', tone: settings.hasToken ? 'ok' : 'warn' }, settings.hasToken ? (settings.tokenSource === 'env' ? t('state.tokenEnv', 'token 来自环境变量') : t('state.tokenFile', 'token 已保存')) : t('state.noToken', '未配置 token')),
            h('span', { key: 'root', style: S.mono }, settings.cloneRoot),
          ]),

          diagOpen && diag !== null
            ? h('div', { key: 'diag', style: S.card }, [
              h('div', { key: 't', style: { ...S.sectionTitle, display: 'flex', justifyContent: 'space-between' } }, [
                h('span', { key: 'l' }, t('section.diagnose', '网络自检结果')),
                h('span', { key: 'c', style: S.details, onClick: () => setDiagOpen(false) }, t('action.close', '收起')),
              ]),
              ...(diag.rows ?? []).map((row, index) => h('div', { key: `r${index}`, style: S.row }, [
                h(Chip, { key: 's', tone: row.ok ? 'ok' : 'error' }, row.ok ? 'OK' : 'FAIL'),
                h('span', { key: 'n', style: S.grow }, row.label ?? (row.strategy === 'mirror' ? `mirror ${row.mirror}` : row.strategy)),
                row.strategy === diag.preferred ? h(Chip, { key: 'p', tone: 'ok' }, t('diag.preferred', '首选')) : null,
                h('span', { key: 'ms', style: S.mono }, `${row.ms} ms`),
                row.ok ? null : h('span', { key: 'e', style: { ...S.mono, flex: 2 } }, row.error ?? ''),
              ])),
            ])
            : null,

          h('div', { key: 'open', style: S.card }, [
            h('div', { key: 't', style: S.sectionTitle }, t('section.open', '打开仓库')),
            h('div', { key: 'url', style: S.row }, [
              h(Input, {
                key: 'i',
                value: urlInput,
                onChange: setUrlInput,
                placeholder: t('hint.url', 'owner/repo，或 https://github.com/owner/repo，或 git@github.com:owner/repo.git'),
                onKeyDown: () => { if (urlInput.trim() !== '' && busy === '') void openRepo(urlInput.trim()) },
              }),
              h(Button, { key: 'go', primary: true, onClick: () => openRepo(urlInput.trim()), disabled: busy !== '' || urlInput.trim() === '' }, t('action.open', '打开')),
            ]),
            h('div', { key: 'repos', style: { marginTop: 10 } }, [
              h('div', { key: 'head', style: S.row }, [
                h(Button, { key: 'load', onClick: loadRepos, disabled: busy !== '' }, t('action.loadRepos', '加载我的仓库')),
                repos === null ? null : h(Input, { key: 'q', value: repoQuery, onChange: setRepoQuery, placeholder: '过滤…' }),
                repos === null ? null : h('span', { key: 'n', style: S.mono }, `${filteredRepos.length}/${repos.length}`),
              ]),
              filteredRepos === null
                ? null
                : h('div', { key: 'list', style: S.list }, filteredRepos.slice(0, 300).map((repo) => h('div', { key: repo.fullName, style: S.listRow }, [
                  h('span', { key: 'n', style: S.grow }, repo.fullName),
                  h(Chip, { key: 'p', tone: repo.private ? 'warn' : undefined }, repo.private ? 'private' : 'public'),
                  h('span', { key: 'b', style: S.mono }, repo.defaultBranch),
                  h(Button, { key: 'o', onClick: () => openRepo(repo.fullName), disabled: busy !== '' }, t('action.open', '打开')),
                ]))),
            ]),

            // 归档导入：网络拉不下来时，用浏览器下载 zip 再拿进来
            h('div', { key: 'import', style: { marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1)', display: 'flex', flexDirection: 'column', gap: 6 } }, [
              h('div', { key: 'lb', style: S.fieldLabel }, t('import.title', '或：导入浏览器下载的归档（没有 git 历史，只读快照）')),
              h('div', { key: 'row', style: S.row }, [
                h('input', {
                  key: 'file',
                  type: 'file',
                  accept: '.zip,.tar.gz,.tgz,.tar',
                  onChange: (event) => {
                    const picked = event.target.files !== null && event.target.files.length > 0 ? event.target.files[0] : null
                    setImportFile(picked)
                    if (picked !== null) setImportRepo(guessRepoFromFile(picked.name))
                  },
                  style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', maxWidth: 260 },
                }),
                h(Input, {
                  key: 'repo',
                  value: importRepo,
                  onChange: setImportRepo,
                  placeholder: 'owner/repo',
                }),
                h(Button, {
                  key: 'go',
                  primary: true,
                  onClick: () => { if (importFile !== null) void importArchive(importFile, importRepo.trim()) },
                  disabled: busy !== '' || importFile === null || importRepo.trim() === '',
                }, t('action.import', '导入')),
              ]),
            ]),
          ]),

          h('div', { key: 'spaces', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
            h('div', { key: 't', style: { ...S.row, justifyContent: 'space-between' } }, [
              h('div', { key: 'l', style: S.sectionTitle }, `${t('section.workspaces', '已打开的工作区')} · ${workspaces.length}`),
              h('div', { key: 'r', style: S.row }, [
                h(Button, { key: 'check', onClick: checkUpdates, disabled: busy !== '' }, t('action.checkUpdates', '检查更新')),
                h(Button, { key: 'pullAll', onClick: pullAll, disabled: busy !== '' || workspaces.length === 0 }, t('action.pullAll', '全部拉取')),
              ]),
            ]),
            workspaces.length === 0
              ? h('div', { key: 'empty', style: { ...S.card, color: 'var(--dsw-alias-label-secondary)' } }, t('state.noWorkspaces', '还没有从 GitHub 打开过仓库。'))
              : workspaces.map((row) => h(WorkspaceCard, {
                key: row.fullName,
                row,
                busy: busy !== '' && busy !== 'load',
                onPull: pull,
                onPush: push,
                onIntegrate: integrate,
                onAbort: abortInt,
                onContinue: continueInt,
                onCommit: commit,
                onCheckout: checkout,
                onDeleteBranch: deleteBranch,
                onReveal: reveal,
                onForget: forget,
              })),
          ]),

          draft === null || settings === null
            ? null
            : h(SettingsCard, {
              key: 'settings',
              draft,
              settings,
              busy: busy !== '',
              proxies,
              onChange: setDraft,
              onSave: save,
              onProbe: probeProxy,
            }),
        ]),
      ])
    }

    /**
     * 新建会话那一行的小入口。
     *
     * 说明：`conversation.hero.workspace.directoryFlow` 是个 single 槽位，且已被内置的
     * 目录选择器占着——注册进去会把「选择目录」顶掉，所以这里只做增量入口：
     * 点一下跳到 GitHub 工作区面板，仓库列表与「打开」都在那儿。
     */
    function HeroGitHubButton() {
      return h('button', {
        type: 'button',
        title: t('hint.openPanel', '打开 GitHub 工作区面板'),
        onClick: () => {
          try {
            const layout = typeof clientCtx?.get === 'function' ? clientCtx.get('layout') : undefined
            if (layout !== undefined && layout !== null && typeof layout.selectPanel === 'function') {
              layout.selectPanel(PANEL_ID)
            }
          } catch {
            /* 跳转失败不影响会话 */
          }
        },
        style: { ...S.button, padding: '3px 8px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 },
      }, [
        h('svg', {
          key: 'i',
          viewBox: '0 0 16 16',
          width: 11,
          height: 11,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        }, [
          h('path', { key: 'p', d: 'M5 4.5v5a2 2 0 0 0 2 2h4' }),
          h('circle', { key: 'a', cx: 5, cy: 3.5, r: 1.4, fill: 'currentColor', stroke: 'none' }),
          h('circle', { key: 'b', cx: 11.5, cy: 11.5, r: 1.4, fill: 'currentColor', stroke: 'none' }),
        ]),
        h('span', { key: 't' }, 'GitHub'),
      ])
    }

    /**
     * 侧边栏图标（壳层给尺寸与选中状态，只画图形）+ 「有仓库落后」角标。
     *
     * 角标数据来自 `/summary`：那条路由只读本地，不发网络请求，所以每分钟轮询
     * 一次是安全的；页面在后台时跳过。它反映的是「上次抓取之后」的落后数，
     * 想看远端真实情况要点面板里的「检查更新」。
     */
    function PanelIcon({ size }) {
      const [behindRepos, setBehindRepos] = useState(0)

      useEffect(() => {
        let alive = true
        const load = async () => {
          if (typeof document !== 'undefined' && document.hidden === true) return
          try {
            const payload = await call(`${API}/summary`)
            if (alive) setBehindRepos(payload.behindRepos ?? 0)
          } catch {
            /* 角标失败不该影响图标本身 */
          }
        }
        void load()
        const timer = setInterval(() => { void load() }, 60_000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }, [
        h('rect', { key: 'b', x: 1.75, y: 2.25, width: 12.5, height: 11.5, rx: 2 }),
        h('path', { key: 'p', d: 'M5.25 5.5v3.25a1.75 1.75 0 0 0 1.75 1.75h3.5' }),
        h('circle', { key: 'c1', cx: 5.25, cy: 4.75, r: 1.15, fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'c2', cx: 11, cy: 10.5, r: 1.15, fill: 'currentColor', stroke: 'none' }),
        behindRepos > 0
          ? h('circle', { key: 'badge', cx: 13.4, cy: 2.6, r: 2.6, fill: 'var(--dsw-alias-state-warn-primary)', stroke: 'none' })
          : null,
      ])
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        clientCtx = ctx

        try {
          ctx.effect(() => ctx.locale.register(NS, DICTS), 'github-workspaces: dictionaries')
          translate = ctx.locale.bind(NS)
        } catch (error) {
          console.warn('[github-workspaces] locale registration failed:', error)
        }

        const disposers = []
        try {
          disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 50,
            label: () => t('entry.label', 'GitHub 工作区'),
          }, PanelIcon)))

          disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
          }, Panel)))

          // 新建会话那一行的轻量入口（增量槽位，不顶替任何内置控件）
          disposers.push(ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
            name: 'conversation.hero.options',
            id: 'github-workspaces',
            order: 20,
          }, HeroGitHubButton)))
        } catch (error) {
          // 面板注册失败只降级 UI，绝不把壳层启动带崩
          console.warn('[github-workspaces] panel registration failed:', error)
        }

        try {
          ctx.effect(() => () => {
            for (const dispose of disposers.splice(0)) {
              try {
                dispose()
              } catch {
                /* 已经释放 */
              }
            }
          }, 'github-workspaces: ui mounts')
        } catch (error) {
          console.warn('[github-workspaces] disposer registration failed:', error)
        }
      },
    }
  },
})

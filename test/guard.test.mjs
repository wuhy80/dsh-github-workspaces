/**
 * A/C 两个护栏的回归测试。
 *
 * A（工具水闸）：纯函数判定 + 用假 ctx 走一遍 installToolGuard，不需要真宿主。
 * C（pushurl 哨兵）：真跑 git，验证「裸 push 被挡住、显式传 URL 的 push 照常成功」
 * ——这正是面板推送与 shell 推送的分野。
 *
 * 用临时目录，不碰网络、不碰用户仓库。
 * 运行：node --test test/
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  ALLOW_ENV,
  PUSH_GUARD_URL,
  blockReason,
  commandFields,
  inspectCommand,
  installToolGuard,
  normalizePath,
  tokenize,
  touchesWorkspace,
} from '../lib/guard.js'
import { GitRunner } from '../lib/git.js'
import { SettingsStore } from '../lib/store.js'

/** 跑一条 git 命令，返回 {status, stdout, stderr}，不抛。 */
function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' })
}

/** 跑一条 git 命令，失败即抛。 */
function gitOk(args, cwd) {
  const result = git(args, cwd)
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`)
  }
  return result.stdout.trim()
}

/** 建一个「工作仓库 + 本地裸远端」，已推过一次 main。 */
function setupRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'gw-guard-'))
  const bare = path.join(root, 'remote.git')
  const work = path.join(root, 'work')
  gitOk(['init', '--bare', '--initial-branch=main', bare], root)
  gitOk(['init', '--initial-branch=main', work], root)
  gitOk(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'one'], work)
  gitOk(['remote', 'add', 'origin', bare], work)
  gitOk(['push', '-u', 'origin', 'main'], work)
  return { root, bare, work }
}

/** 假 store：只提供 guard / cloneRoot / records 三个入口。 */
function fakeStore(overrides = {}) {
  return {
    state: { guard: { tool: true, pushUrl: true } },
    cloneRoot: () => 'D:\\githubCode',
    records: () => [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// A：命令判定
// ---------------------------------------------------------------------------

test('推送类命令会被识别', () => {
  const cases = [
    'git push',
    'git push origin main',
    'git push --force-with-lease origin main',
    'git.exe push origin HEAD:main',
    'git -C D:/githubCode/o/r push',
    'git -c user.name=x push',
    'cd repo && git push',
    'git status; git push',
    'git status\ngit push',
    'cmd /c git push',
    'bash -lc "git push origin main"',
    '& "C:\\Program Files\\Git\\cmd\\git.exe" push',
  ]
  for (const command of cases) {
    const hits = inspectCommand(command)
    assert.equal(hits.length, 1, `应该拦下：${command}（实际 ${hits.length} 个命中）`)
    assert.equal(hits[0].kind, 'push')
  }
})

test('历史改写类命令会被识别', () => {
  assert.equal(inspectCommand('git rebase origin/main')[0]?.kind, 'rewrite')
  assert.equal(inspectCommand('git filter-branch --all')[0]?.kind, 'rewrite')
  assert.equal(inspectCommand('git reset --hard HEAD~1')[0]?.kind, 'rewrite')
  // 软重置不改历史，放行
  assert.deepEqual(inspectCommand('git reset --soft HEAD~1'), [])
})

test('读命令与本地命令不受影响', () => {
  const safe = [
    'git status',
    'git log --oneline -5',
    'git diff HEAD',
    'git fetch origin',
    'git add -A',
    'git commit -m "更新"',
    'git branch -a',
    'npm test',
    'echo hello',
    'gitu push',
  ]
  for (const command of safe) {
    assert.deepEqual(inspectCommand(command), [], `不该拦：${command}`)
  }
  // push 连 --dry-run 一起拦（哨兵对 dry-run 同样生效，留着只会自相矛盾）
  assert.equal(inspectCommand('git push --dry-run').length, 1)
})

test('提交信息里出现 git push 不会被误判', () => {
  // 整段 span 被 commit 消费掉，里面的字面量不算一条命令
  assert.deepEqual(inspectCommand('git commit -m "git push 到 main"'), [])
  assert.deepEqual(inspectCommand("git commit -m 'git reset --hard'"), [])
})

test('引号内的嵌套命令仍然能识别', () => {
  assert.equal(inspectCommand('powershell -NoProfile -Command "git push"').length, 1)
})

test('tokenize 把换行当作命令分隔', () => {
  assert.deepEqual(tokenize('git status\ngit push'), ['git', 'status', '\n', 'git', 'push'])
})

test('commandFields 挑出命令类字段，数组也支持', () => {
  assert.deepEqual(commandFields({ command: 'git push' }), ['git push'])
  assert.deepEqual(commandFields({ code: 'await tools.pwsh({ command: "git push" })' }).length, 1)
  assert.deepEqual(commandFields({ commands: ['git status', 'git push'] }), ['git status', 'git push'])
  assert.deepEqual(commandFields({ path: 'README.md' }), [])
  assert.deepEqual(commandFields(null), [])
})

// ---------------------------------------------------------------------------
// A：作用域
// ---------------------------------------------------------------------------

test('只对克隆根与已登记仓库生效', () => {
  const store = fakeStore({
    records: () => [{ path: 'D:\\githubCode\\wuhy80\\dsh-github-workspaces' }],
  })
  // 会话 cwd 在克隆根下 → 命中
  assert.equal(touchesWorkspace(store, 'D:\\githubCode\\other\\repo', ['git push']), true)
  // 已登记仓库本身 → 命中
  assert.equal(touchesWorkspace(store, 'D:/githubCode/wuhy80/dsh-github-workspaces', ['git push']), true)
  // 完全无关的项目 → 不管
  assert.equal(touchesWorkspace(store, 'C:\\work\\other', ['git push']), false)
  // cwd 拿不到，但命令里点名了仓库路径 → 命中
  assert.equal(touchesWorkspace(store, '', ['git -C D:\\githubCode\\wuhy80\\dsh-github-workspaces push']), true)
  // 前缀长得像但不是同一个目录 → 不命中（避免 D:\githubCode2 误伤）
  assert.equal(touchesWorkspace(store, 'D:\\githubCode2\\x', ['git push']), false)
})

test('normalizePath 归一 Windows 路径', () => {
  assert.equal(normalizePath('D:\\GitHubCode\\o\\r\\'), 'd:/githubcode/o/r')
  assert.equal(normalizePath(''), '')
})

test('拒绝理由指向 dsh-gh（同一条推送链路）并给出放行方式', () => {
  const text = blockReason([{ action: '推送' }])
  assert.match(text, /面板/)
  assert.match(text, /已阻止：推送/)
  // shell 里的替代方案：同一个 WorkspaceOpener，不是裸 git push
  assert.match(text, /dsh-gh\.mjs/)
  assert.match(text, /sync/)
  assert.ok(text.includes(ALLOW_ENV))
})

// ---------------------------------------------------------------------------
// A：水闸接线
// ---------------------------------------------------------------------------

/** 假的 ctx：只实现 on 与 tools.guard，workingDirectory 缺失。 */
function fakeCtx() {
  const captured = {}
  const ctx = {
    captured,
    on: (event, handler) => {
      captured[event] = handler
      return () => undefined
    },
  }
  ctx.tools = {
    guard: (fn) => {
      captured['tools.guard'] = fn
      return () => undefined
    },
  }
  return ctx
}

const allow = () => ({ kind: 'allow' })

test('工作区里的 git push 被拒，别的目录放行', async () => {
  const ctx = fakeCtx()
  const store = fakeStore()
  installToolGuard({ ctx, store })
  const handler = ctx.captured['tools/pre-execute']
  assert.equal(typeof handler, 'function')

  const denied = await handler(
    { name: 'pwsh', arguments: { command: 'git push origin main', workdir: 'D:\\githubCode\\o\\r' } },
    allow,
  )
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /面板/)

  const allowed = await handler(
    { name: 'pwsh', arguments: { command: 'git push origin main', workdir: 'C:\\work\\other' } },
    allow,
  )
  assert.equal(allowed.kind, 'allow')
})

test('读命令、非 shell 工具、关掉开关时都放行', async () => {
  const ctx = fakeCtx()
  const store = fakeStore()
  installToolGuard({ ctx, store })
  const handler = ctx.captured['tools/pre-execute']

  assert.equal((await handler({ name: 'pwsh', arguments: { command: 'git status', workdir: 'D:\\githubCode\\o\\r' } }, allow)).kind, 'allow')
  assert.equal((await handler({ name: 'read', arguments: { file_path: 'git push' } }, allow)).kind, 'allow')
  assert.equal((await handler({ name: 'pwsh', arguments: { command: 'git push', workdir: 'D:\\githubCode\\o\\r' } }, allow)).kind, 'deny')

  store.state.guard.tool = false
  assert.equal((await handler({ name: 'pwsh', arguments: { command: 'git push', workdir: 'D:\\githubCode\\o\\r' } }, allow)).kind, 'allow')
})

test('环境变量放行开关生效', async () => {
  const ctx = fakeCtx()
  installToolGuard({ ctx, store: fakeStore() })
  const handler = ctx.captured['tools/pre-execute']
  const before = process.env[ALLOW_ENV]
  process.env[ALLOW_ENV] = '1'
  try {
    const allowed = await handler({ name: 'pwsh', arguments: { command: 'git push', workdir: 'D:\\githubCode\\o\\r' } }, allow)
    assert.equal(allowed.kind, 'allow')
  } finally {
    if (before === undefined) delete process.env[ALLOW_ENV]
    else process.env[ALLOW_ENV] = before
  }
})

test('同步兜底 guard：命令里点名仓库路径时也能拦（不依赖会话 cwd）', () => {
  const ctx = fakeCtx()
  const store = fakeStore({ records: () => [{ path: 'D:\\githubCode\\wuhy80\\dsh-github-workspaces' }] })
  installToolGuard({ ctx, store })
  const guard = ctx.captured['tools.guard']
  assert.equal(typeof guard, 'function')

  const denied = guard({ name: 'pwsh', arguments: { command: 'git -C D:\\githubCode\\wuhy80\\dsh-github-workspaces push' } })
  assert.equal(typeof denied, 'string')
  assert.match(denied, /面板/)

  // 无关路径 / 读命令 / 别的工具都返回 undefined（放行）
  assert.equal(guard({ name: 'pwsh', arguments: { command: 'git -C C:\\work\\other push' } }), undefined)
  assert.equal(guard({ name: 'pwsh', arguments: { command: 'git -C D:\\githubCode\\wuhy80\\dsh-github-workspaces status' } }), undefined)
  assert.equal(guard({ name: 'read', arguments: { command: 'git push' } }), undefined)
})

// ---------------------------------------------------------------------------
// C：pushurl 哨兵
// ---------------------------------------------------------------------------

test('哨兵挡住裸 push，但放行显式传 URL 的 push（面板走的就是这条）', async () => {
  const { root, bare, work } = setupRepo()
  const home = path.join(root, 'home')
  try {
    const store = new SettingsStore(home)
    store.update({ guard: { pushUrl: true } })
    const runner = new GitRunner(store)

    const installed = await runner.installPushGuard(work)
    assert.equal(installed.ok, true)
    assert.equal(installed.changed, true)
    assert.equal(gitOk(['config', '--get', 'remote.origin.pushurl'], work), PUSH_GUARD_URL)

    // 裸 git push（shell 里的形态）→ 被 pushurl 挡住
    gitOk(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'two'], work)
    const barePush = git(['push', 'origin', 'HEAD:main'], work)
    assert.notEqual(barePush.status, 0, '裸 push 应该失败')
    assert.match(`${barePush.stderr}${barePush.stdout}`, /127\.0\.0\.1/)

    // 面板的形态：git push <url> HEAD:<branch>，git 不读 pushurl
    const explicitPush = git(['push', bare, 'HEAD:main'], work)
    assert.equal(explicitPush.status, 0, `显式 URL 的 push 应该成功：${explicitPush.stderr}`)

    // 幂等：再装一次不重复写
    const again = await runner.installPushGuard(work)
    assert.equal(again.changed, false)

    // 解除后裸 push 恢复
    const removed = await runner.removePushGuard(work)
    assert.equal(removed.changed, true)
    assert.notEqual(git(['config', '--get', 'remote.origin.pushurl'], work).status, 0, '解除后配置项应该消失')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('用户自己配的 pushurl 不被覆盖', async () => {
  const { root, work } = setupRepo()
  try {
    const store = new SettingsStore(path.join(root, 'home'))
    const runner = new GitRunner(store)
    gitOk(['config', 'remote.origin.pushurl', 'https://example.com/mirror.git'], work)

    const result = await runner.installPushGuard(work)
    assert.equal(result.skipped, 'user-pushurl')
    assert.equal(gitOk(['config', '--get', 'remote.origin.pushurl'], work), 'https://example.com/mirror.git')

    const removed = await runner.removePushGuard(work)
    assert.equal(removed.skipped, 'user-pushurl')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('设置里关掉 pushUrl 时不装哨兵', async () => {
  const { root, work } = setupRepo()
  try {
    const store = new SettingsStore(path.join(root, 'home'))
    store.update({ guard: { pushUrl: false } })
    const runner = new GitRunner(store)
    const result = await runner.installPushGuard(work)
    assert.equal(result.skipped, 'disabled')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

test('老设置文件没有 guard 段时默认开启两道护栏', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'gw-guard-home-'))
  try {
    writeFileSync(path.join(home, 'dsh-github-workspaces.json'), JSON.stringify({ version: 1, token: '' }))
    const store = new SettingsStore(home)
    assert.deepEqual(store.state.guard, { tool: true, pushUrl: true })
    assert.deepEqual(store.snapshot().guard, { tool: true, pushUrl: true })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('guard 开关能写回并读回来', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'gw-guard-home-'))
  try {
    const store = new SettingsStore(home)
    store.update({ guard: { tool: false } })
    assert.equal(store.state.guard.tool, false)
    assert.equal(store.state.guard.pushUrl, true)
    // 重新读一次，确认落盘
    const again = new SettingsStore(home)
    assert.equal(again.state.guard.tool, false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

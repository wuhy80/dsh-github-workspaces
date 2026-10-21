/**
 * 同步路径的回归测试：直接跑插件真正会执行的那几条 git 命令。
 *
 * 覆盖两个曾经真实存在的 bug：
 * 1. fetch 带 `--depth 1` → 新提交成了浅边界 → `merge --ff-only` 报
 *    `refusing to merge unrelated histories`，拉取永远失败；
 * 2. 按 URL fetch / push 不更新 `refs/remotes/origin/*` → `ahead/behind` 永远是错的。
 *
 * 用临时裸仓库当远端，不碰网络、不碰用户仓库。
 * 运行：node --test test/
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { archiveKind, countEscapes, extractArchive, guessRepoName, unwrapSingleDirectory } from '../lib/archive.js'
import { WorkspaceOpener } from '../lib/opener.js'
import { probePort } from '../lib/proxy-probe.js'

import { GitRunner, fetchArgs, integrateArgs, mergeArgs, parseStatusZ, trackingRef } from '../lib/git.js'
import { run } from '../lib/proc.js'
import { SettingsStore } from '../lib/store.js'

/** 跑一条 git 命令，失败即抛。 */
function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`)
  }
  return result.stdout.trim()
}

/** 建一个"远端 + 上游工作区 + 浅克隆"的三件套。 */
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'gw-sync-'))
  const bare = path.join(root, 'upstream.git')
  const work = path.join(root, 'work')
  const clone = path.join(root, 'clone')
  git(['init', '--bare', '--initial-branch=main', bare], root)
  git(['init', '--initial-branch=main', work], root)
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'one'], work)
  git(['remote', 'add', 'origin', bare], work)
  git(['push', '-u', 'origin', 'main'], work)
  const url = `file:///${bare.replace(/\\/g, '/')}`
  // 与插件默认行为一致：浅克隆
  git(['clone', '--depth', '1', '--single-branch', url, clone], root)
  return { root, bare, work, clone, url, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** 在上游工作区追加一个提交并推回远端。 */
function advance(env, message) {
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', message], env.work)
  git(['push', 'origin', 'main'], env.work)
  return git(['rev-parse', 'main'], env.bare)
}

test('fetch 参数不带 --depth（浅边界会让 --ff-only 判不出祖先）', () => {
  assert.equal(fetchArgs('https://example.invalid/x/y.git', 'main').includes('--depth'), false)
  assert.equal(mergeArgs('main').at(-1), trackingRef('main'))
})

test('浅克隆 + 远端前进 + 插件的 fetch/merge 序列：能快进且跟踪 ref 同步', () => {
  const env = setup()
  try {
    const before = git(['rev-parse', 'HEAD'], env.clone)
    const remote = advance(env, 'two')
    assert.notEqual(remote, before)

    git(fetchArgs(env.url, 'main'), env.clone)
    assert.equal(git(['rev-parse', trackingRef('main')], env.clone), remote, 'fetch 应把跟踪 ref 推进到远端')

    git(mergeArgs('main'), env.clone)
    assert.equal(git(['rev-parse', 'HEAD'], env.clone), remote, 'merge --ff-only 应快进到远端')
    assert.equal(git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], env.clone), '0\t0', '快进后 ahead/behind 必须归零')
    assert.equal(git(['rev-parse', '--is-shallow-repository'], env.clone), 'true', '拉取不应悄悄把仓库变全量')
  } finally {
    env.cleanup()
  }
})

test('推送到 URL 之后补 update-ref，ahead 才会归零', () => {
  const env = setup()
  try {
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'local'], env.clone)
    assert.equal(git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], env.clone), '1\t0')

    git(['push', env.url, 'HEAD:main'], env.clone)
    // 直接推 URL 不会动 origin/main —— 这正是面板一直显示「待推 1」的原因
    assert.equal(git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], env.clone), '1\t0')

    git(['update-ref', trackingRef('main'), 'HEAD'], env.clone)
    assert.equal(git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], env.clone), '0\t0', 'update-ref 之后 ahead 必须归零')
  } finally {
    env.cleanup()
  }
})

test('超时后立即结算（不能等子进程自己退出）', async () => {
  const started = Date.now()
  const result = await run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 1200 })
  const elapsed = Date.now() - started
  assert.equal(result.timedOut, true)
  assert.equal(result.code, null)
  assert.ok(elapsed < 15_000, `超时应在数秒内返回，实际 ${elapsed}ms`)
})

test('AbortSignal 会杀掉进程并标记 aborted', async () => {
  const controller = new AbortController()
  const pending = run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    timeoutMs: 60_000,
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 300)
  const result = await pending
  assert.equal(result.aborted, true)
  assert.equal(result.timedOut, false)
})

test('parseStatusZ 认出中文路径、未跟踪与重命名（-z 的两段格式）', () => {
  const raw = ' M 中文 文件.md\u0000?? new.txt\u0000R  new.md\u0000old.md\u0000'
  const files = parseStatusZ(raw)
  assert.deepEqual(files.map((file) => file.path), ['中文 文件.md', 'new.txt', 'new.md'])
  assert.equal(files[0].label, '修改')
  assert.equal(files[1].untracked, true)
  assert.equal(files[1].label, '未跟踪')
  assert.equal(files[2].renamedFrom, 'old.md')
  assert.equal(files[2].label, '重命名')
})

test('ensureCloneRoot 会把多级不存在的目录建出来', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'gw-store-'))
  try {
    const target = path.join(home, 'githubCode', 'a', 'b')
    const store = new SettingsStore(home)
    store.state.cloneRoot = target
    assert.equal(existsSync(target), false)
    assert.equal(store.ensureCloneRoot(), target)
    assert.equal(existsSync(target), true)
    // 幂等：已存在时再调一次也不报错
    assert.equal(store.ensureCloneRoot(), target)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('ensureCloneRoot 在盘符不存在时给出可读报错', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'gw-store-'))
  try {
    const store = new SettingsStore(home)
    store.state.cloneRoot = 'Z:\\definitely-not-a-drive\\x'
    assert.throws(() => store.ensureCloneRoot(), /无法创建克隆根目录/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('integrateArgs 变基/合并都对着跟踪 ref', () => {
  assert.deepEqual(integrateArgs('rebase', 'main'), ['rebase', trackingRef('main')])
  assert.deepEqual(integrateArgs('merge', 'main'), ['merge', '--no-edit', trackingRef('main')])
})

test('分叉后变基：本地提交被重放到远端之上', () => {
  const env = setup()
  try {
    advance(env, 'upstream')
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'local'], env.clone)
    git(fetchArgs(env.url, 'main'), env.clone)
    assert.equal(git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], env.clone), '1\t1', '应先形成 1 领先 1 落后的分叉')

    git(integrateArgs('rebase', 'main'), env.clone)

    assert.equal(git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], env.clone), '1\t0', '变基后应只剩领先 1')
    assert.equal(git(['log', '-1', '--format=%s'], env.clone), 'local', '顶层仍是本地那个提交')
    assert.equal(git(['log', '-1', '--format=%s', 'HEAD^'], env.clone), 'upstream', '本地提交应落在远端之上')
  } finally {
    env.cleanup()
  }
})

test('变基冲突时能识别中间态并中止回原状', async () => {
  const env = setupConflict()
  try {
    const store = new SettingsStore(env.root)
    const runner = new GitRunner(store)
    git(fetchArgs(env.url, 'main'), env.clone)

    // 直接用插件会执行的命令序列，确保它真的冲突
    const attempted = spawnSync('git', ['-C', env.clone, ...integrateArgs('rebase', 'main')], { encoding: 'utf8' })
    assert.notEqual(attempted.status, 0, '冲突时应返回非 0')

    assert.equal(runner.repoState(env.clone), 'rebasing')
    assert.deepEqual(await runner.conflictedFiles(env.clone), ['f.txt'])

    const aborted = await runner.abortIntegration(env.clone)
    assert.equal(aborted.ok, true)
    assert.equal(runner.repoState(env.clone), 'clean', '中止后应回到干净状态')
    assert.equal(git(['log', '-1', '--format=%s'], env.clone), 'local', '中止不应丢掉本地提交')
  } finally {
    env.cleanup()
  }
})

/** 同一行冲突的三件套。 */
function setupConflict() {
  const root = mkdtempSync(path.join(tmpdir(), 'gw-conflict-'))
  const bare = path.join(root, 'upstream.git')
  const work = path.join(root, 'work')
  const clone = path.join(root, 'clone')
  git(['init', '--bare', '--initial-branch=main', bare], root)
  git(['init', '--initial-branch=main', work], root)
  writeFileSync(path.join(work, 'f.txt'), 'base\n')
  git(['add', '-A'], work)
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'base'], work)
  git(['remote', 'add', 'origin', bare], work)
  git(['push', '-u', 'origin', 'main'], work)
  const url = `file:///${bare.replace(/\\/g, '/')}`
  git(['clone', '--depth', '1', '--single-branch', url, clone], root)
  // 远端改这一行
  writeFileSync(path.join(work, 'f.txt'), 'upstream\n')
  git(['add', '-A'], work)
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'upstream'], work)
  git(['push', 'origin', 'main'], work)
  // 本地也改这一行 → 必然冲突
  writeFileSync(path.join(clone, 'f.txt'), 'local\n')
  git(['add', '-A'], clone)
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'local'], clone)
  return { root, bare, work, clone, url, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('分支：新建、列表、切回、安全删除，并拒绝删除当前分支', async () => {
  const env = setup()
  const runner = new GitRunner(new SettingsStore(env.root))
  try {
    const created = await runner.checkout(env.clone, 'feature-x', { create: true })
    assert.equal(created.ok, true)
    assert.equal(created.branch, 'feature-x')

    const listed = await runner.branches(env.clone)
    assert.equal(listed.ok, true)
    assert.equal(listed.current, 'feature-x')
    assert.equal(listed.detached, false)
    assert.deepEqual(listed.local.map((item) => item.name).sort(), ['feature-x', 'main'])
    assert.equal(listed.local.find((item) => item.current === true).name, 'feature-x')

    const refusedCurrent = await runner.deleteBranch(env.clone, 'feature-x')
    assert.equal(refusedCurrent.ok, false)
    assert.match(refusedCurrent.error, /当前/)

    const back = await runner.checkout(env.clone, 'main')
    assert.equal(back.ok, true)
    assert.equal((await runner.deleteBranch(env.clone, 'feature-x')).ok, true)
    assert.deepEqual((await runner.branches(env.clone)).local.map((item) => item.name), ['main'])
  } finally {
    env.cleanup()
  }
})

test('游离 HEAD 能被识别，并靠检出分支救回来', async () => {
  const env = setup()
  const runner = new GitRunner(new SettingsStore(env.root))
  try {
    git(['checkout', '--detach', 'HEAD'], env.clone)
    const detached = await runner.branches(env.clone)
    assert.equal(detached.detached, true)
    assert.equal(detached.current, '')

    const rescued = await runner.checkout(env.clone, 'main')
    assert.equal(rescued.ok, true)
    assert.equal(rescued.branch, 'main')
    assert.equal((await runner.branches(env.clone)).detached, false)
  } finally {
    env.cleanup()
  }
})

test('有未合并提交的分支不会被安全删除', async () => {
  const env = setup()
  const runner = new GitRunner(new SettingsStore(env.root))
  try {
    await runner.checkout(env.clone, 'topic', { create: true })
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'topic-work'], env.clone)
    await runner.checkout(env.clone, 'main')

    const refused = await runner.deleteBranch(env.clone, 'topic')
    assert.equal(refused.ok, false)
    assert.match(refused.error, /未合并/)
    // 分支仍在
    assert.equal((await runner.branches(env.clone)).local.some((item) => item.name === 'topic'), true)
  } finally {
    env.cleanup()
  }
})

test('summarize 一条命令拿到分支/ahead/behind/改动数', async () => {
  const env = setup()
  const runner = new GitRunner(new SettingsStore(env.root))
  try {
    let summary = await runner.summarize(env.clone)
    assert.equal(summary.ok, true)
    assert.equal(summary.branch, 'main')
    assert.equal(summary.ahead, 0)
    assert.equal(summary.behind, 0)
    assert.equal(summary.dirty, 0)
    assert.equal(summary.detached, false)

    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'local'], env.clone)
    summary = await runner.summarize(env.clone)
    assert.equal(summary.ahead, 1)

    advance(env, 'upstream')
    git(fetchArgs(env.url, 'main'), env.clone)
    summary = await runner.summarize(env.clone)
    assert.equal(summary.behind, 1, '抓取后应看到落后 1')

    writeFileSync(path.join(env.clone, 'new.txt'), 'x')
    summary = await runner.summarize(env.clone)
    assert.equal(summary.dirty, 1)

    git(['checkout', '--detach', 'HEAD'], env.clone)
    summary = await runner.summarize(env.clone)
    assert.equal(summary.detached, true)
    assert.equal(summary.branch, '')
  } finally {
    env.cleanup()
  }
})

test('归档：类型识别与仓库名推测', () => {
  assert.equal(archiveKind('a.zip'), 'zip')
  assert.equal(archiveKind('a.TAR.GZ'), 'tar.gz')
  assert.equal(archiveKind('a.tgz'), 'tar.gz')
  assert.equal(archiveKind('a.7z'), '')
  assert.equal(guessRepoName('obsidian-vault-main.zip'), 'obsidian-vault')
  assert.equal(guessRepoName('Hello-World-master.tar.gz'), 'Hello-World')
  assert.equal(guessRepoName('dsh-github-workspaces-main.zip'), 'dsh-github-workspaces')
})

test('归档解压：单层目录会被摊平，且无越界条目', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gw-archive-'))
  try {
    const src = path.join(root, 'src')
    mkdirSync(path.join(src, 'repo-main'), { recursive: true })
    writeFileSync(path.join(src, 'repo-main', 'a.txt'), 'one\n')
    writeFileSync(path.join(src, 'repo-main', 'b.txt'), 'two\n')
    const archive = path.join(root, 'repo-main.tar.gz')
    const packed = spawnSync('tar', ['-czf', archive, '-C', src, 'repo-main'], { encoding: 'utf8' })
    assert.equal(packed.status, 0, packed.stderr)

    const dest = path.join(root, 'dest')
    mkdirSync(dest)
    const extracted = await extractArchive(archive, dest)
    assert.equal(extracted.ok, true)
    assert.equal(unwrapSingleDirectory(dest), true)
    assert.deepEqual(readdirSync(dest).sort(), ['a.txt', 'b.txt'])
    assert.equal(countEscapes(dest), 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('代理探测：识别 SOCKS5 端口，关闭端口返回 null', async () => {
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      // SOCKS5 方法选择应答：05 00（无需认证）
      socket.write(Buffer.from([0x05, 0x00]))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const hit = await probePort(port)
    assert.equal(hit.port, port)
    assert.equal(hit.kind, 'socks5')
    assert.equal(await probePort(1), null)
  } finally {
    server.close()
  }
})

test('只读快照：写操作被守卫拒绝', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'gw-snapshot-'))
  try {
    const store = new SettingsStore(home)
    const runner = new GitRunner(store)
    const ctx = { workspaceRegistry: { create: async () => ({ id: 'ws-1', title: 'snap' }) } }
    const opener = new WorkspaceOpener(ctx, store, runner, { listRepos: async () => [] })
    store.remember('someone/snap', { path: home, title: 'snap', snapshot: true, source: 'archive' })

    for (const action of [
      opener.pull('someone/snap'),
      opener.push('someone/snap'),
      opener.commit('someone/snap', 'msg', ['a.txt']),
      opener.branches('someone/snap'),
      opener.checkout('someone/snap', 'dev'),
      opener.deleteBranch('someone/snap', 'dev'),
      opener.integrate('someone/snap', 'rebase'),
    ]) {
      const result = await action
      assert.equal(result.ok, false)
      assert.match(result.error, /只读快照/)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { fetchArgs, mergeArgs, parseStatusZ, trackingRef } from '../lib/git.js'
import { run } from '../lib/proc.js'

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

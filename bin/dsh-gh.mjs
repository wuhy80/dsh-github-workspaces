#!/usr/bin/env node
/**
 * dsh-gh —— 在 shell 里走「GitHub 工作区」的推送/拉取链路。
 *
 * 为什么需要它：面板的推送不是裸 `git push`，而是
 *   直连 → SSH-over-443 降级、按远端注入 token、报错里把 token 抹成 ***、
 *   成功后补 update-ref（否则面板会一直显示「待推」）。
 * shell 里的 `git push` 没有这些，所以插件的护栏会拦它。
 *
 * 这个命令直接调用面板用的同一个 WorkspaceOpener —— 也就是说：**同样的代码路径**，
 * 不复制一份逻辑。agent 和人都可以在 shell 里用它。
 *
 * 用法：
 *   node bin/dsh-gh.mjs status [owner/repo]        # 分支 / 待推 / 待拉 / 改动
 *   node bin/dsh-gh.mjs pull   [owner/repo]        # 快进拉取（失败不 force）
 *   node bin/dsh-gh.mjs push   [owner/repo]        # 推送当前 HEAD
 *   node bin/dsh-gh.mjs commit -m "信息" [owner/repo]   # 提交全部改动（不推送）
 *   node bin/dsh-gh.mjs sync   -m "信息" [owner/repo]   # 提交全部改动 + 推送
 *
 * 不写 owner/repo 时按当前目录推断（取已登记仓库里最长的匹配路径）。
 */

import path from 'node:path'
import process from 'node:process'

import { SettingsStore } from '../lib/store.js'
import { GitRunner } from '../lib/git.js'
import { GitHubApi } from '../lib/github.js'
import { WorkspaceOpener } from '../lib/opener.js'

const useColor = process.stdout.isTTY === true
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text)
const ok = (text) => console.log(`${paint(32, '✓')} ${text}`)
const bad = (text) => console.error(`${paint(31, '✗')} ${text}`)
const info = (text) => console.log(`  ${text}`)

/** 解析参数：子命令 + 选项 + 位置参数。 */
function parseArgs(argv) {
  const options = { message: '', repo: '', dir: '', json: false, help: false }
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') options.help = true
    else if (arg === '--json') options.json = true
    else if (arg === '-m' || arg === '--message') options.message = argv[++i] ?? ''
    else if (arg.startsWith('--message=')) options.message = arg.slice('--message='.length)
    else if (arg === '--repo') options.repo = argv[++i] ?? ''
    else if (arg.startsWith('--repo=')) options.repo = arg.slice('--repo='.length)
    else if (arg === '--dir') options.dir = argv[++i] ?? ''
    else if (arg.startsWith('--dir=')) options.dir = arg.slice('--dir='.length)
    else if (!arg.startsWith('-')) positional.push(arg)
  }
  return { command: positional[0] ?? '', target: options.repo || positional[1] || '', options }
}

const HELP = `dsh-gh —— 在 shell 里走 GitHub 工作区的推送链路（直连 → SSH-over-443、token 注入、报错脱敏）

用法：
  dsh-gh status [owner/repo]
  dsh-gh pull   [owner/repo]
  dsh-gh push   [owner/repo]
  dsh-gh commit -m "信息" [owner/repo]
  dsh-gh sync   -m "信息" [owner/repo]     # 提交全部改动 + 推送

  --dir <路径>   不要求登记，直接对某个本地仓库执行（插件自己的源码仓库也能用）
  --json         status 输出 JSON

不写 owner/repo 时按当前目录推断。`

/** 按 cwd 推断登记项：取路径前缀最长的一条。 */
function repoFromCwd(store, cwd) {
  const here = path.resolve(cwd).replace(/[\\/]+$/, '').toLowerCase()
  let best = null
  for (const record of store.records()) {
    const target = path.resolve(record.path).replace(/[\\/]+$/, '').toLowerCase()
    if (here === target || here.startsWith(`${target}${path.sep}`)) {
      if (best === null || target.length > best.length) best = record.fullName
    }
  }
  return best ?? ''
}

/** 打印推送/拉取的阶段进度。 */
const onStage = (event) => {
  if (event && typeof event.text === 'string' && event.text !== '') info(event.text)
}

async function main() {
  const argv = process.argv.slice(2)
  const { command, target, options } = parseArgs(argv)

  if (options.help || command === '' || command === 'help') {
    console.log(HELP)
    return command === '' ? 1 : 0
  }

  const store = new SettingsStore()
  const git = new GitRunner(store)
  const api = new GitHubApi(store)
  // push/pull/commit 不碰 ctx（只有 open 那类操作要 workspaceRegistry），给个空壳即可
  const opener = new WorkspaceOpener({}, store, git, api)

  // --dir：不要求登记，直接对某个本地仓库跑同一条链路（插件自己的源码仓库也适用）
  if (options.dir !== '') {
    const dir = path.resolve(options.dir)
    const token = store.token()
    switch (command) {
      case 'status': {
        const status = await git.status(dir)
        if (options.json) {
          console.log(JSON.stringify(status, null, 2))
          return status.ok === false ? 1 : 0
        }
        if (status.ok === false) {
          bad(`${dir}：${status.error ?? '不是可用的 git 仓库'}`)
          return 1
        }
        ok(`${path.basename(dir)}  ${status.branch ?? '-'}  改动 ${status.dirty ?? 0} · 待推 ${status.ahead ?? 0} · 待拉 ${status.behind ?? 0}`)
        info(dir)
        return 0
      }
      case 'pull': {
        const result = await git.pull(dir, store.state.network.mode, token, { onStage })
        if (result.ok === false) {
          bad(`拉取失败：${result.error ?? '未知原因'}`)
          if (result.detail) info(result.detail)
          return 1
        }
        ok(`拉取完成${result.strategy ? `（${result.strategy}）` : ''}`)
        return 0
      }
      case 'push': {
        const result = await git.pushHead(dir, { token, onStage })
        if (result.ok === false) {
          bad(`推送失败：${result.error ?? '未知原因'}`)
          if (result.detail) info(result.detail)
          return 1
        }
        ok(`已推送${result.strategy ? `（${result.strategy}）` : ''}${result.branch ? ` · ${result.branch}` : ''}`)
        return 0
      }
      case 'commit':
      case 'sync': {
        const text = options.message.trim()
        if (text === '') {
          bad('缺少提交信息：用 -m "..." 指定')
          return 1
        }
        const committed = await git.commitSelected(dir, { paths: null, message: text, token, onStage })
        if (committed.ok === false) {
          bad(`提交失败：${committed.error ?? '未知原因'}`)
          if (committed.detail) info(committed.detail)
          return 1
        }
        if (committed.committed === false) {
          info('没有改动需要提交')
          if (command === 'commit') return 0
        } else {
          ok(`已提交${committed.files ? ` ${committed.files} 个文件` : ''}${committed.branch ? ` · ${committed.branch}` : ''}`)
        }
        if (command === 'commit') return 0
        const pushed = await git.pushHead(dir, { token, onStage })
        if (pushed.ok === false) {
          bad(`推送失败：${pushed.error ?? '未知原因'}`)
          if (pushed.detail) info(pushed.detail)
          return 1
        }
        ok(`已推送${pushed.strategy ? `（${pushed.strategy}）` : ''}`)
        return 0
      }
      default:
        bad(`不认识的子命令：${command}`)
        console.log(HELP)
        return 1
    }
  }

  const fullName = target !== '' ? target : repoFromCwd(store, process.cwd())
  if (fullName === '') {
    bad('没指定仓库，当前目录也不在任何已登记的工作区里')
    info(`已登记：${store.records().map((record) => record.fullName).join('、') || '（空）'}`)
    return 1
  }
  const record = store.records().find((item) => item.fullName === fullName)
  if (record === undefined) {
    bad(`没有登记过的仓库：${fullName}`)
    info(`已登记：${store.records().map((item) => item.fullName).join('、') || '（空）'}`)
    return 1
  }

  switch (command) {
    case 'status': {
      const status = await opener.status(fullName)
      if (options.json) {
        console.log(JSON.stringify(status, null, 2))
        return status.ok === false ? 1 : 0
      }
      if (status.ok === false) {
        bad(`${fullName}：${status.error}`)
        return 1
      }
      ok(`${fullName}  ${status.branch ?? '-'}  改动 ${status.dirty ?? status.dirtyCount ?? 0} · 待推 ${status.ahead ?? 0} · 待拉 ${status.behind ?? 0}`)
      info(record.path)
      return 0
    }

    case 'pull': {
      const result = await opener.pull(fullName, { onStage })
      if (result.ok === false) {
        bad(`${fullName} 拉取失败：${result.error ?? '未知原因'}`)
        if (result.detail) info(result.detail)
        if (result.diverged === true) info('本地有远端没有的提交，已按策略处理（不会 force）')
        return 1
      }
      ok(`${fullName} 拉取完成${result.strategy ? `（${result.strategy}）` : ''}`)
      return 0
    }

    case 'push': {
      const result = await opener.push(fullName, { onStage })
      if (result.ok === false) {
        bad(`${fullName} 推送失败：${result.error ?? '未知原因'}`)
        if (result.detail) info(result.detail)
        return 1
      }
      ok(`${fullName} 已推送${result.strategy ? `（${result.strategy}）` : ''}${result.branch ? ` · ${result.branch}` : ''}`)
      return 0
    }

    case 'commit':
    case 'sync': {
      const text = options.message.trim()
      if (text === '') {
        bad('缺少提交信息：用 -m "..." 指定')
        return 1
      }
      const committed = await opener.commit(fullName, text, null, { onStage })
      if (committed.ok === false) {
        bad(`${fullName} 提交失败：${committed.error ?? '未知原因'}`)
        if (committed.detail) info(committed.detail)
        return 1
      }
      if (committed.committed === false) {
        info('没有改动需要提交')
        if (command === 'commit') return 0
      } else {
        ok(`${fullName} 已提交${committed.files ? ` ${committed.files} 个文件` : ''}${committed.branch ? ` · ${committed.branch}` : ''}`)
      }
      if (command === 'commit') return 0

      const pushed = await opener.push(fullName, { onStage })
      if (pushed.ok === false) {
        bad(`${fullName} 推送失败：${pushed.error ?? '未知原因'}`)
        if (pushed.detail) info(pushed.detail)
        return 1
      }
      ok(`${fullName} 已推送${pushed.strategy ? `（${pushed.strategy}）` : ''}`)
      return 0
    }

    default:
      bad(`不认识的子命令：${command}`)
      console.log(HELP)
      return 1
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    bad(error instanceof Error ? error.message : String(error))
    process.exit(1)
  },
)

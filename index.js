/**
 * dsh-github-workspaces — 宿主半边。
 *
 * 挂载三样东西：
 * 1. /api/dsh-github-workspaces 路由族（面板的数据通道）；
 * 2. github_workspace agent 工具（只读 + 拉取）；
 * 3. 一条 systemPrompt 说明，让 agent 知道有这个面板与工具。
 *
 * 浏览器半边（./client）负责侧边栏入口与 main 面板的渲染，通过 bundle 的
 * dsh.client 声明加载。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SettingsStore } from './lib/store.js'
import { GitRunner } from './lib/git.js'
import { GitHubApi } from './lib/github.js'
import { WorkspaceOpener } from './lib/opener.js'
import { makeRoutes } from './lib/routes.js'
import { GITHUB_WORKSPACES_GUIDANCE, githubWorkspaceTool } from './lib/tools.js'

/** 稳定的 Cordis 插件名。 */
export const name = 'github-workspaces'

/** 依赖的服务：没有它们这个插件没有意义。 */
export const inject = ['webServer', 'tools', 'systemPrompt', 'workspaceRegistry']

/** 说明段落的位置（排在 dsh-ssh 的 150 之后）。 */
const SECTION_ORDER = 152

/** 挂载诊断：宿主进程的 console 抓不到，失败原因落盘才好排查。 */
function logMount(message) {
  try {
    const file = path.join(os.homedir(), '.dsh', 'dsh-github-workspaces-mount.log')
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    /* 诊断失败不影响主流程 */
  }
}

/** 把异常压成一行（带栈）。 */
function describe(error) {
  if (error instanceof Error) return `${error.message}\n${error.stack ?? ''}`
  return String(error)
}

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 */
export function apply(ctx) {
  const store = new SettingsStore()
  const git = new GitRunner(store)
  const api = new GitHubApi(store)
  const opener = new WorkspaceOpener(ctx, store, git, api)

  // 「没有就建立一个」：挂载时确保克隆根目录存在（失败只记日志，不阻塞插件）
  try {
    const root = store.ensureCloneRoot()
    logMount(`clone root ready: ${root}`)
  } catch (error) {
    logMount(`clone root unavailable: ${describe(error)}`)
  }

  // 数据通道
  ctx.effect(() => {
    const disposers = makeRoutes({ store, git, api, opener }).map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'github-workspaces: routes')

  // agent 工具：注册失败不该拖垮插件（面板仍然可用）
  ctx.effect(() => {
    try {
      const disposer = ctx.tools.register(githubWorkspaceTool({ store, git, api, opener }))
      logMount('tool registered: github_workspace')
      return disposer
    } catch (error) {
      logMount(`tool registration failed: ${describe(error)}`)
      return () => {}
    }
  }, 'github-workspaces: tool')

  // 让 agent 知道插件存在与边界
  ctx.effect(() => {
    try {
      return ctx.systemPrompt.section({
        name: 'plugin:github-workspaces',
        order: SECTION_ORDER,
        text: GITHUB_WORKSPACES_GUIDANCE,
      })
    } catch (error) {
      logMount(`guidance section failed: ${describe(error)}`)
      return () => {}
    }
  }, 'github-workspaces: guidance')
}

/**
 * 子进程小工具：统一 spawn 包装、超时、输出截断，以及可执行文件探测。
 *
 * 宿主进程直接起进程（不经过 DSH 的 subprocess 服务），与 dsh-ssh 起 ssh2
 * 是同一层级：这意味着 git 不受文件沙箱约束，所以所有会改动远端状态的
 * 动作（提交、推送）只在面板里由用户显式触发，agent 工具不提供。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'

/** 单次调用保留的输出上限（超出只留尾部）。 */
const MAX_OUTPUT = 192 * 1024

/**
 * 执行一个可执行文件，收集 stdout/stderr。
 * @param {string} exe - 可执行文件（绝对路径，或 PATH 里的名字）。
 * @param {string[]} args - 参数数组，不经 shell，天然免注入。
 * @param {{cwd?: string, env?: Record<string,string>, timeoutMs?: number, input?: string}} [options]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, error?: string, timedOut: boolean, durationMs: number}>}
 */
export function run(exe, args, options = {}) {
  const { cwd, env, timeoutMs = 120_000 } = options
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let child
    try {
      child = spawn(exe, args, {
        cwd,
        env: { ...process.env, ...(env ?? {}) },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({
        code: null,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error),
        timedOut: false,
        durationMs: Date.now() - startedAt,
      })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退出 */
      }
    }, Math.max(1_000, timeoutMs))
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    const finish = (code, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code,
        stdout: clip(stdout),
        stderr: clip(stderr),
        error,
        timedOut,
        durationMs: Date.now() - startedAt,
      })
    }
    child.on('error', (error) => finish(null, error.message))
    child.on('close', (code) => finish(code, undefined))
  })
}

/** 超长输出只保留尾部，前面标注截断。 */
function clip(text) {
  if (typeof text !== 'string' || text.length <= MAX_OUTPUT) return text ?? ''
  return '[输出已截断]\n' + text.slice(text.length - MAX_OUTPUT)
}

/**
 * 探测一个可执行文件的候选路径：返回第一个能跑通的，找不到返回 null。
 * @param {string[]} candidates - 候选名或绝对路径，按顺序尝试。
 * @param {string[]} probeArgs - 用来验证的轻量参数。
 * @param {number} [timeoutMs] - 单个候选的超时。
 * @returns {Promise<{path: string, stdout: string} | null>}
 */
export async function probeExecutable(candidates, probeArgs, timeoutMs = 8_000) {
  for (const candidate of candidates) {
    // 绝对路径先看存不存在，省一次 spawn 失败
    if (/[\\/]/.test(candidate) && !fs.existsSync(candidate)) continue
    const result = await run(candidate, probeArgs, { timeoutMs })
    if (result.code === 0) return { path: candidate, stdout: result.stdout.trim() }
  }
  return null
}

/** git 候选路径（Windows 上 Git for Windows 的两个常见安装位置也列上）。 */
const GIT_CANDIDATES = [
  'git',
  'git.exe',
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
]

let gitProbe
/**
 * 解析 git 可执行文件，结果缓存在进程内。
 * @returns {Promise<{path: string, version: string} | null>}
 */
export function resolveGit() {
  if (gitProbe === undefined) {
    gitProbe = probeExecutable(GIT_CANDIDATES, ['--version']).then((found) =>
      found === null ? null : { path: found.path, version: found.stdout.replace(/^git version\s*/i, '') },
    )
  }
  return gitProbe
}

let curlProbe
/**
 * 解析 curl（Windows 10+ 自带），用于「本地代理」链路访问 GitHub API。
 * @returns {Promise<string | null>}
 */
export function resolveCurl() {
  if (curlProbe === undefined) {
    curlProbe = probeExecutable(['curl.exe', 'curl', 'C:\\Windows\\System32\\curl.exe'], ['--version']).then(
      (found) => (found === null ? null : found.path),
    )
  }
  return curlProbe
}

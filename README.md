# GitHub 工作区（dsh-github-workspaces）

把 **GitHub 仓库当 DSH 工作区**：一个 GitHub 项目 = 一个工作区，工作区标题就是仓库名；
拉取、提交、推送都直接对 GitHub。为国内网络准备了四条链路和自动降级。

## 它做了什么

- **侧边栏新增「GitHub 工作区」面板**（侧边栏图标 + 中央整页），`/api/dsh-github-workspaces` 提供数据。
- **打开仓库 = 克隆 + 登记工作区**：克隆到 `<cloneRoot>/<owner>/<repo>`，然后
  `workspaceRegistry.create(path, 仓库名)`。标题只在新登记时使用，不会覆盖你手动改过的名字。
- **已打开的仓库卡片**：分支、未提交改动数、待推 / 待拉提交数、HEAD 摘要；可拉取、**按文件勾选提交**、打开目录、移除登记（保留文件）。
- **改动勾选 + 单文件 diff**：卡片上的「改动」展开文件列表（新增 / 修改 / 删除 / 重命名 / 未跟踪，重命名显示 `旧 → 新`），
  点文件名看该文件的 diff（未跟踪文件回内容本身，二进制与大文件只给提示），勾选后只提交这些文件——不再是 `add -A` 一把梭。
  提交与推送也走流式：暂存 → 提交 → 推送三段进度，可取消。
- **长任务有进度、可取消**：克隆与拉取走 NDJSON 流，面板显示当前阶段（直连 / SSH-over-443 / 镜像 / 合并）与下载百分比，
  点「取消」会中止请求并由宿主杀掉 git 子进程。
- **agent 工具 `github_workspace`**：`list | status | open | pull | diagnose | repos`。

## 国内网络：四条链路 + 自动降级

| 策略 | 做法 | 说明 |
|---|---|---|
| `direct` | `https://github.com/...` | 配了 token 时自动带上 `x-access-token` 鉴权 |
| `ssh443` | `git@github.com:...` 重写成 `ssh://git@ssh.github.com:443/` | 22 端口被封时通常还有救；需要本机 SSH key |
| `mirror` | `https://ghfast.top/https://github.com/...` | 只用于**读**；推送不走镜像 |
| `proxy` | 设 `network.proxy`（如 `http://127.0.0.1:7890`） | GitHub API 走 `curl --proxy`；**git 也会带上 `http.proxy` / `https.proxy`** |

`mode=auto`（默认）按 **直连 → SSH-over-443 → 镜像** 依次尝试；镜像候选内置
`ghfast.top` / `gh-proxy.com` / `ghproxy.net`。任何一次成功都会把该策略记为
**首选策略并写入设置**（`network.preferred`），重启后第一次克隆也不用再白等直连超时。
面板的「网络自检」并行探测每条链路（单条 8 秒判死），给出耗时与错误，并标出当前首选。

另外每个 git 调用都带 `core.longpaths`、`http.version=HTTP/1.1`，避免 Windows 长路径与
弱网下的 `RPC failed`；默认 `--depth 1 --single-branch` 浅克隆。

## 同步的正确性（0.2.0 修复）

两个曾经会让「拉取」直接失效、让「待推/待拉」永远错位的问题，现在都有回归测试兜着：

1. **fetch 不带 `--depth`**。带浅标记抓下来的新提交本身是浅边界（没有父提交），
   git 会判定它和本地 HEAD 无关，`merge --ff-only` 直接报
   `refusing to merge unrelated histories`。去掉 `--depth` 后仍保持浅克隆（测试里断言
   `rev-parse --is-shallow-repository` 仍为 `true`）。
2. **fetch 写显式 refspec、merge 合跟踪 ref、push 后补 `update-ref`**。
   按 URL fetch/push 不会更新 `refs/remotes/origin/*`，而 `ahead/behind` 正是拿
   `@{upstream}` 比的——不补这几步，拉完还会一直显示「待拉 N」。

## 安全边界

- 宿主进程直接调用 git，**不经过 DSH 文件沙箱**（与 dsh-ssh 调 ssh2 同级）。
- 因此**提交与推送只在面板里由用户手动点击**：agent 工具不提供这两个动作。
- 拉取只做快进（`merge --ff-only`）；本地与远端分叉时报「需人工处理」并给出手动
  `git pull --rebase` 的建议，**从不 reset、从不 force push**。
- 所有返回给前端/模型的报错都会把 token 抹成 `***`。
- 设置落在 `$DSH_HOME/dsh-github-workspaces.json`（权限 0600）；token 也可直接用环境变量
  `GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_PAT`（优先于文件）。

## 设置项

| 字段 | 默认 | 含义 |
|---|---|---|
| `token` | 空 | GitHub PAT（列私有仓库、推送需要）；环境变量优先 |
| `cloneRoot` | `D:\githubCode`（Windows）/ `~/dsh-github-workspaces` | 克隆根目录；不存在会自动创建 |
| `network.mode` | `auto` | `auto` / `direct` / `mirror` / `proxy` / `ssh443` |
| `network.mirror` | `https://ghfast.top/` | 镜像前缀 |
| `network.proxy` | 空 | 本地代理（API 与 git 都用） |
| `network.preferred` | 空 | 实测可用的读策略，auto 模式优先使用 |
| `network.apiBase` | `https://api.github.com` | 可替换为镜像 API |
| `author.name` / `author.email` | 空 | 提交身份；留空则读 git 全局配置，再留空会明确报错 |
| `clone.shallow` | `true` | 是否浅克隆 |

## 结构

```
index.js            宿主入口：注册路由 / 工具 / 提示段落
lib/store.js        设置与仓库登记（0600 JSON）
lib/proc.js         子进程包装（超时 / 取消 / 进度）、git 与 curl 探测
lib/git.js          克隆/状态/拉取/提交推送/网络自检 + 策略降级
lib/github.js       REST（仓库列表、身份）+ 仓库地址解析
lib/opener.js       仓库 → 工作区（先克隆，再登记）
lib/routes.js       /api/dsh-github-workspaces 路由族（loopback 门禁；open/pull/commit 为 NDJSON 流）
lib/tools.js        github_workspace 工具（标准 JSON Schema）
client.js           浏览器半边：sidebar.panellist + main 面板（含进度条与取消）
test/sync.test.mjs  同步路径回归测试（临时裸仓库，不碰网络）
```

## 测试

```bash
node --test test/sync.test.mjs
```

五条用例：fetch 参数不再带 `--depth`；浅克隆 + 远端前进 + 插件的 fetch/merge 序列能快进且
跟踪 ref 同步、仓库仍是浅克隆；推送到 URL 后补 `update-ref` 使 ahead 归零；超时后立即结算；
`AbortSignal` 中止会杀掉子进程并标记 `aborted`。

## 已知限制

- 浅克隆的仓库没有完整历史；需要时可手动 `git fetch --unshallow`。
- 镜像前缀只能读，推送必须直连或 SSH。
- diff 是纯文本展示（不做语法高亮/并排）；单文件超过 200 KB 会截断。
- 面板不需要 Cordis Config schema（设置走自己的面板），所以插件详情页里没有配置表单。
- 首次打开一个大仓库会慢；克隆超时 420 s，可随时取消。

## 变更日志

- 0.3.0 — 改动勾选 + 单文件 diff；提交/推送走流式
- 0.2.0 — 修好浅克隆下的拉取与 ahead/behind


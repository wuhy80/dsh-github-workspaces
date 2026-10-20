# GitHub 工作区（dsh-github-workspaces）

把 **GitHub 仓库当 DSH 工作区**：一个 GitHub 项目 = 一个工作区，工作区标题就是仓库名；
拉取、提交、推送都直接对 GitHub。为国内网络准备了四条链路和自动降级。

## 它做了什么

- **侧边栏新增「GitHub 工作区」面板**（侧边栏图标 + 中央整页），`/api/dsh-github-workspaces` 提供数据。
- **打开仓库 = 克隆 + 登记工作区**：克隆到 `<cloneRoot>/<owner>/<repo>`，然后
  `workspaceRegistry.create(path, 仓库名)`。标题只在新登记时使用，不会覆盖你手动改过的名字。
- **已打开的仓库卡片**：分支、未提交改动数、待推 / 待拉提交数、HEAD 摘要；可拉取、提交并推送、打开目录、移除登记（保留文件）。
- **agent 工具 `github_workspace`**：`list | status | open | pull | diagnose | repos`。

## 国内网络：四条链路 + 自动降级

| 策略 | 做法 | 说明 |
|---|---|---|
| `direct` | `https://github.com/...` | 配了 token 时自动带上 `x-access-token` 鉴权 |
| `ssh443` | `git@github.com:...` 重写成 `ssh://git@ssh.github.com:443/` | 22 端口被封时通常还有救；需要本机 SSH key |
| `mirror` | `https://ghfast.top/https://github.com/...` | 只用于**读**；推送不走镜像 |
| `proxy` | 设 `network.proxy`（如 `http://127.0.0.1:7890`） | GitHub API 走 `curl --proxy`；git 克隆建议配合镜像或 SSH |

`mode=auto`（默认）按 **直连 → SSH-over-443 → 镜像** 依次尝试；镜像候选内置
`ghfast.top` / `gh-proxy.com` / `ghproxy.net`。任何一次成功都会把该策略记为
**本次进程的优先策略**，后续拉取/推送不再先白等直连超时。
试过都失败时，面板的「网络自检」会给出每条链路的耗时与错误，便于判断该配代理还是配 SSH。

另外每个 git 调用都带 `core.longpaths`、`http.version=HTTP/1.1`，避免 Windows 长路径与
弱网下的 `RPC failed`；默认 `--depth 1 --single-branch` 浅克隆。

## 安全边界

- 宿主进程直接调用 git，**不经过 DSH 文件沙箱**（与 dsh-ssh 调 ssh2 同级）。
- 因此**提交与推送只在面板里由用户手动点击**：agent 工具不提供这两个动作。
- 拉取只做快进（`merge --ff-only`）；本地与远端分叉时报「需人工处理」，**从不 reset、从不 force push**。
- 所有返回给前端/模型的报错都会把 token 抹成 `***`。
- 设置落在 `$DSH_HOME/dsh-github-workspaces.json`（权限 0600）；token 也可直接用环境变量
  `GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_PAT`（优先于文件）。

## 设置项

| 字段 | 默认 | 含义 |
|---|---|---|
| `token` | 空 | GitHub PAT（列私有仓库、推送需要）；环境变量优先 |
| `cloneRoot` | `~/dsh-github-workspaces` | 克隆根目录 |
| `network.mode` | `auto` | `auto` / `direct` / `mirror` / `proxy` / `ssh443` |
| `network.mirror` | `https://ghfast.top/` | 镜像前缀 |
| `network.proxy` | 空 | 本地代理（GitHub API 用） |
| `network.apiBase` | `https://api.github.com` | 可替换为镜像 API |
| `author.name` / `author.email` | 空 | 提交身份；留空则读 git 全局配置，再留空会明确报错 |
| `clone.shallow` | `true` | 是否浅克隆 |

## 结构

```
index.js            宿主入口：注册路由 / 工具 / 提示段落
lib/store.js        设置与仓库登记（0600 JSON）
lib/proc.js         子进程包装、git/curl 探测
lib/git.js          克隆/状态/拉取/提交推送/网络自检 + 策略降级
lib/github.js       REST（仓库列表、身份）+ 仓库地址解析
lib/opener.js       仓库 → 工作区（先克隆，再登记）
lib/routes.js       /api/dsh-github-workspaces 路由族（loopback 门禁）
lib/tools.js        github_workspace 工具（标准 JSON Schema）
client.js           浏览器半边：sidebar.panellist + main 面板
```

## 已知限制

- 浅克隆的仓库没有完整历史；需要时可手动 `git fetch --unshallow`。
- 镜像前缀只能读，推送必须直连或 SSH。
- 面板不需要 Cordis Config schema（设置走自己的面板），所以插件详情页里没有配置表单。
- 首次打开一个大仓库会慢；克隆超时 420 s。

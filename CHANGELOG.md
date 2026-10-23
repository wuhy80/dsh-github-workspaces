# 变更日志

## 0.10.0

- **A · 工具水闸**：监听宿主 `tools/pre-execute`，拦下 shell 里对已登记仓库的
  `git push` / `git rebase` / `git reset --hard` / `git filter-branch`，返回「请改用面板」的
  拒绝理由（含链路降级与 token 脱敏的说明）；读命令与本地 `add`/`commit` 照常放行
- **C · pushurl 哨兵**：克隆/打开时写入 `remote.origin.pushurl`，让任何不传 URL 的
  `git push` 连不出去；面板推送显式传 URL 不受影响。用户自配的 pushurl 不覆盖
- 设置项 `guard.tool` / `guard.pushUrl`（默认开启）+ 面板开关；切换时同步到所有已登记仓库
- 命令判定走分词而非裸正则：`-C`/`-c` 选项、`cmd /c`、`bash -lc "..."` 都能识别，
  `git commit -m "git push"` 不会误伤
- 新增 `test/guard.test.mjs`（18 条），含 pushurl 的真实行为断言

## 0.4.0

- 分叉处理：面板内显式选择「变基到远端」或「合并远端」
- 冲突时列出冲突文件，提供「继续」与「中止整合」
- 「推送」按钮：只推当前 HEAD，变基之后或在终端里提交过之后都能用
- status 增加仓库中间态（rebasing / merging）与冲突文件列表

## 0.3.1

- 克隆根默认落到 `D:\githubCode`，不存在时自动创建
- `ensureCloneRoot()` 在多级目录、盘符不存在时给出可读报错

## 0.3.0

- 改动勾选与单文件 diff 预览，提交不再 `add -A` 一把梭
- 提交与推送改为 NDJSON 流，可取消

## 0.2.0

- 修复浅克隆下拉取必然失败（fetch 不再带 `--depth`）
- 修复拉取/推送后 ahead/behind 永久错位（显式 refspec + update-ref）
- 本地代理同时作用于 git；首选策略持久化；自检并行化
- 超时/取消改为杀进程树，避免 Windows 上挂死

## 0.1.0

- 首个版本：侧边栏面板、以仓库名登记工作区、四条网络链路自动降级
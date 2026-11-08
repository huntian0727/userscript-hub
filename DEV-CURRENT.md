# 115 多宫格播放器 2.0 — 当前开发检查点

> 本文件是恢复开发的第一入口。每完成一个可独立验证的功能切片、每个里程碑结束、每次长任务暂停或中断前都必须更新。实时状态优先于本文件中的历史快照。

## 项目身份
- 项目：115 多宫格播放器 2.0（独立油猴脚本升级）
- Runner：HOME / MP2T8QB5
- Runner client_id：`mp2t8qb5-664698f51f0940b3`
- WebCodex Project：`agent:mp2t8qb5-664698f51f0940b3:115-v1-0-0-3d603680-9ba27f05`
- 工作树：`C:\Users\test\.webcodex-worktrees\115-v1-0-0-3d603680`
- 分支：`develop/random-playback-v2.0`
- 基线：v1.8.4，基线提交 `9ae33baa8bc9ec5238cf4324320ecc88f92337e9`
- 发布目标：v2.0.0；独立更新通道，不覆盖历史版本。

## 最近一次核对的代码状态
- 当前业务修复与发布提交：`9c63345a9d4f4f582740a5ae9cd3b7d088cade4a`（短 SHA：`9c63345`）；已推送至 GitHub `main`，Pages Actions #82 成功。
- 上一版 2.0.0 发布提交：`fb5d7f9c2337c7053fd308dae690f7af6584335a`；本次 2.0.1 修复提交：`fix(115): repair v2 scheme save dropdown`。
- 当前工作区：修复已提交并推送；HEAD 与 origin/main 一致。
- 本次 2.0.1 修复：方案下拉刷新函数误调用未定义的 `option()`；改为在当前作用域内通过 `element('option', ...)` 创建原生选项。保存后刷新列表不再触发该 ReferenceError。新增不可变快照 `history/115-multiview-random-v2/2.0.1.user.js`。
- M6 将旧 `N115IndexStore` 缩减为只读 `N115LegacyFavoriteLookup`：仅供旧收藏条目补全信息；删除旧索引创建/扫描/写入/删除 API，随机播放不依赖旧索引。保留旧 IndexedDB 数据，不执行清库。
- 同目录播放状态变量已改为读取/加载语义；移除旧索引措辞和扫描依赖。删除视频后只清理播放器收藏/排除偏好，不再更新旧索引数据库。
- M5 2.0 交付范围为本地 JSON 导出/导入与结构校验；用户可手动上传到 115 根目录 `拉面多宫格播放器/配置备份`。自动上传、云端回读及当前/上一份自动轮换延期 2.1；未验证公开授权 API 前禁止调用未公开接口。
- 用户明确：真实 115 环境测试由用户安装后自行完成；助手不登录/扫码/执行真实账号测试，且不阻塞 2.0 发布。
- 旧版 v0.12.4 与 v1.9.1 入口和历史快照保留；2.0 是单独 namespace、单独安装/更新 URL。- M6 将旧 `N115IndexStore` 缩减为只读 `N115LegacyFavoriteLookup`：仅供旧收藏条目补全信息；删除旧索引创建/扫描/写入/删除 API，随机播放不依赖旧索引。保留旧 IndexedDB 数据，不执行清库。
- 同目录播放状态变量已改为读取/加载语义；移除旧索引措辞和扫描依赖。删除视频后只清理播放器收藏/排除偏好，不再更新旧索引数据库。
- M5 2.0 交付范围为本地 JSON 导出/导入与结构校验；用户可手动上传到 115 根目录 `拉面多宫格播放器/配置备份`。自动上传、云端回读及当前/上一份自动轮换延期 2.1；未验证公开授权 API 前禁止调用未公开接口。
- 用户明确：真实 115 环境测试由用户安装后自行完成；助手不登录/扫码/执行真实账号测试，且不阻塞 2.0 发布。
- 发布授权：用户已明确要求尽快发布 2.0；允许完成验证后提交、推送、合并至 main 并发布独立入口。必须保持 v0.12.4/v1.9.1 旧入口及历史快照不变。

## 最近一次验证证据
- 脚本语法：`node --check userscripts/115-multiview-random-v2.user.js` 通过。
- 专项测试：`node --test tests/115-random-playback-v2-engine.test.js tests/115-full-disk-explorer-adapter.test.js tests/parallel-releases.test.js`，40/40 passed。
- 完整检查：`npm test`，217/217 tests passed；`npm run build` 与 `npm run check` 均通过；构建成功生成 6 个脚本（包含独立 2.0.1）。
- 本次新增专项回归测试：方案下拉渲染不得引用未定义的 `option()`，且必须创建原生 option 元素。
- GitHub Actions 部署工作流 #82（commit `9c63345`）已成功。验证边界：自动化测试/构建不等于真实 115 账号冒烟；当前 ChatGPT 浏览器控制连接未建立，未进行登录态浏览器实测；真实账号验收仍由用户负责。

## 2.0 里程碑
权威计划见 `docs/RANDOM-PLAYBACK-V2-IMPLEMENTATION.md`。
- M1 随机 API 适配器与纯随机引擎：已完成。
- M2 统一来源配置与文件夹选择器：已完成自动化验证；真实 115 体验由用户验收。
- M3 核心播放、失败跳过、补充队列、锁定窗口、新轮次：主要逻辑和行为测试已完成。
- M4 保存方案与排序：已完成；方案保存/置顶/手动排序/删除及 JSON 备份排序字段已实现。
- M5 本地 JSON 导出/导入与结构校验：已实现；自动 115 云端上传/轮换/回读校验延期 2.1。
- M6 旧索引写入/扫描/UI/播放依赖移除：已完成；仅保留旧收藏只读兼容查询，专项和完整自动化检查通过。
- M7 自动化检查、独立构建、差异审查、提交推送和 Pages 部署：已完成；线上 manifest/meta/安装脚本与 SHA256 核验通过。真实 115 测试由用户自行安装后执行。

## 已确认产品规则## 当前测试恢复点（2026-11-08）
- 当前安装版本：2.0.1；方案保存失败 `option is not defined` 已修复并发布。
- 安装入口：`https://huntian0727.github.io/userscript-hub/userscripts/115-multiview-random-v2.user.js`。
- 下一步优先级：待浏览器连接可用后执行 M1 页面启动与控制台检查，再执行 M2 保存/应用/编辑/删除/排序/刷新恢复；随后依次 M3-M6。真实 115 账号数据不得清理或破坏。
- 浏览器控制前置条件：需要从已安装 ChatGPT 浏览器扩展的原始浏览器会话打开本对话并建立连接；当前调用返回 originating browser context unavailable。不要将代码级测试描述为真实 UI 测试。


- 多来源按 115 文件 ID 去重，不做内容哈希。
- 文件夹模式支持一个或多个文件夹，默认递归子文件夹；全盘模式忽略文件夹选择。
- 关键词按视频文件名 OR 匹配；排除词本地过滤；支持最小/最大文件大小。
- 按 115 匹配视频数量自然加权随机；每轮不重复；锁定宫格不替换；播放失败项跳过。
- 方案保存来源范围、文件夹 ID/路径、过滤条件和排序；新建方案及使用方案后置顶；不依赖最近使用时间戳。
- 本地 JSON 备份/恢复可手动上传到 115 专用目录；2.0 不自动上传云端。
- 旧索引仅供历史收藏信息只读补全；不扫描、不写入、不参与播放；不删除旧数据。
- 收藏夹随机来源暂缓；既有收藏能力保持独立。

## 2.0 快速交付决策（2026-11-08）
- 目标为尽快交付 P0 最小完整可用版本，不以非关键优化或真实 115 账号测试阻塞发布。
- 2.1 延后：自动云端备份、自动轮换/回读、收藏夹随机来源、压力/长稳/极端异常全矩阵、内部函数穷尽测试、非关键重构、统计诊断、额外动画布局和 UI 微调。
- 真实 115 环境验收由用户在安装后完成；助手只做自动化测试、构建、版本与发布核验。

## 发布结果（2026-11-08）
- GitHub：`https://github.com/huntian0727/userscript-hub/commit/fb5d7f9c2337c7053fd308dae690f7af6584335a`
- main 已从 `edadef0` 快进到 `fb5d7f9`；GitHub Actions #81（Build and deploy Userscript Hub）结论 success。
- Pages：`https://huntian0727.github.io/userscript-hub/`；线上 `api/manifest.json`、v2.0 meta、安装脚本均返回 HTTP 200。
- manifest 版本 2.0.0；线上安装脚本大小 447,939 bytes；下载脚本 SHA256 与 manifest 当前版本和 2.0.0 历史快照一致。
- v2.0 安装地址：`https://huntian0727.github.io/userscript-hub/userscripts/115-multiview-random-v2.user.js`
- v2.0 更新地址：`https://huntian0727.github.io/userscript-hub/userscripts/115-multiview-random-v2.meta.js`
- v2.0 回滚快照：`https://huntian0727.github.io/userscript-hub/history/115-multiview-random-v2/2.0.0.user.js`
- 旧版保留：v1.9.1 `https://huntian0727.github.io/userscript-hub/userscripts/115-multiview-full-disk.user.js`；v0.12.4 `https://huntian0727.github.io/userscript-hub/userscripts/115-multiview-indexed.user.js`。
- 用户验收清单：首次安装/菜单入口、文件夹多选和递归、全盘模式、关键词/排除/大小过滤、随机去重与新轮次、单格/全部换片、锁定、失败跳过、方案保存/排序、JSON 导入导出。由用户在真实 115 环境自行执行；助手不代测。

## 当前 Session 线索
- Active Session：`wc_sess_xlxEnN--OamBT9E3`（session_ref：`~s91`）。
- 恢复时仍需对当前 Project 执行 `list_sessions` 并明确选择返回的 Active Session，再读取 handoff；重新核对当前 Git 状态和活动 Job。

## 下一步
- 等待用户在真实 115 环境安装并验收 2.0；根据实际反馈修复阻塞性缺陷。
- 其他非关键优化、自动 115 云端备份/回读/轮换、收藏夹作为随机来源和压力/长稳测试统一进入 2.1。
- 用户未反馈真实验收前，不宣称真实账号验证已完成。
## 当前 Session 线索
- 最近一次明确恢复的 Active Session：`wc_sess_xlxEnN--OamBT9E3`（session_ref：`~s91`）。
- Session ID 只是检索线索；恢复时仍需对当前 Project 执行 `list_sessions` 并明确选择返回的 Active Session，再读取 handoff。
- 最近一次 handoff 显示 0 个活动 Job；恢复时必须重新检查。

## 停止/中断时必须补齐
- 当前里程碑及完成条件；
- 修改文件及每项修改目的；
- Git branch、HEAD、staged/unstaged/untracked 清单；
- 测试命令、数量、通过/失败、构建结果；
- 验证对应的源码 freshness；
- 活动 Job ID / observation_ref（若有）；
- 未解决风险、用户待决策事项、下一步唯一主任务。

# 115 多宫格播放器 2.0 — 当前开发检查点

> 本文件是恢复开发的第一入口。每完成一个可独立验证的功能切片、每个里程碑结束、每次长任务暂停或中断前都必须更新。实时状态优先于本文件中的历史快照。

## 2026-11-08 性能交接进展（最新）
- 分支 develop/random-playback-v2.0，基线 HEAD 3792e9e；原有未提交 2.0.5 更改已保留。
- 既有未提交 2.0.5 快照与新增诊断不一致；构建器禁止覆盖快照，因此保留它并递增至 2.0.6。
- 代码审查：候选最多 4 路；每格独立播放地址请求和 HLS 实例，无播放器全局串行锁。真实服务器延迟、分片、限流和长期内存尚未测量，不能认定根因或宣称真实提速。
- 新增默认关闭的控制台计时：在 115 页面执行 localStorage.setItem('115-v2-timing', '1') 后重新打开播放器；console.debug 的 [115-v2 timing] 输出候选、地址、清单、canplay、playing 和启动时刻，不输出账号、文件名或 URL。关闭：localStorage.removeItem('115-v2-timing')。
- 模拟测试验证 4/6/9 路地址请求并发及单格失败隔离；HLS 使用 mock 验证独立启动。真实 115 验收和限流确认由用户完成。
- 修改文件：userscript、meta、registry、版本测试、两项性能测试、2.0.6 快照和本检查点；原 2.0.5 快照未覆盖。
- 验证：语法检查通过；候选专项通过；最终源码语法与专项测试通过；npm run check：227 项通过、历史检查和构建通过。仍未完成模拟端到端播放耗时对比、长期内存/请求积累验证，故尚未提交或发布。。下一步重跑全部检查、审查差异并按授权发布，核验部署。

## 2026-11-08 关键词性能修复（最新）
- 用户确认 v2.0.6 使用单关键词和文件大小筛选仍慢。对照 1.9.1：旧版从关键词搜索结果抽取，v2 从全盘逐项抽取再本地过滤；此差异可导致候选命中率低、补格缓慢，未证明真实环境唯一根因。
- 开发版递增至 2.0.7，保留 2.0.5/2.0.6 快照。单关键词全盘优先用115搜索，再本地验证关键词、大小、排除词和去重；搜索受限/不可用则回退原路径，多关键词保持 OR 全盘抽样。
- 模拟数据 100 个视频、3 个匹配关键词：完整遍历候选旧路径 101 次读取，搜索路径 4 次；并发、真实网络和实际播放时间不能由此推断。专项测试、全量 230 项、build、check（含历史快照）及 git diff --check 通过；准备提交发布。

## 2026-11-08 v2.0.7 发布核验（最新）
- 正式 main 提交 0a1a987565b995d042f7b1bb41f180c5071712f6；GitHub Actions 42489758921 构建与部署成功。
- Pages manifest、安装脚本、meta 均为 2.0.7；安装脚本与 2.0.7 快照 SHA256 均为 bba953beacd6ec49adb20f296f4b37ed12df73422781ff6602f3e69f8a5b6b30。2.0.4 回滚快照 HTTP 200。
- 自动化 230 项通过；用户自测真实关键词+大小筛选。真实115耗时、限流、长期内存和请求积累仍未验证。
- HOME Runner 已核对无活动 Job；本环境未提供 Session 查询/交接工具，未写 Session progress。

## 2026-11-08 v2.0.8 智能画幅修复
- 分支 `develop/random-playback-v2.0`，基线 `0a1a987`。混合横竖屏时智能画幅引用缺失的评分常量，布局更新中断后宫格挤在左上角。恢复评分常量和候选布局选择。
- 修改独立 v2 脚本、meta、registry 和版本回归测试，新增 4/6/9 格布局回归测试及 2.0.8 快照。
- `node --check`、布局专项、`npm run build`、`npm run check`（233 项和历史校验）通过。
- main 与本地开发分支发布提交为 `74afe1f`，GitHub Actions `42490312738` 部署成功。线上 manifest、固定更新 meta 与安装脚本均为 2.0.8，安装包与新快照 SHA256 同为 `1556a210f50d2cd2975b509f05a6d00cf540cafe5c8c45ff0a8353972dec8bce`，2.0.7 和 2.0.4 回滚快照可访问。
- 发布后仅开发检查点和日志有本地追加。HOME Runner 无活动 Job，当前工具未提供会话查询和 progress 写入。下一步由用户刷新真实 115 页面验收。

## 2026-11-08 v2.0.9 文件夹选择器修复
- 分支 `develop/random-playback-v2.0`，基线 `74afe1f`。目录分页未提供取消信号，公共请求函数直接读取 `signal.aborted`，目录请求发送前即失败。允许请求省略取消信号，读取失败时只显示错误状态。
- 文件夹浏览器、目录适配器与公共请求函数联动测试在旧版复现同一异常，修复后可读取并添加目录。语法、专项、构建及 `npm run check`（234 项与历史校验）通过。
- 递增 v2 独立入口至 2.0.9，生成 2.0.9 历史快照。下一步核验安装中心部署。

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
- 当前分支：`develop/random-playback-v2.0`；项目仍使用独立 v2 更新通道。
- 最新待发布修复版本：2.0.5（全盘随机候选并发提速；本轮构建和自动化检查通过，等待 Pages 部署）。
- 2.0.2 修复：JSON 合并导入遇到同名但不同 ID 的收藏夹时，保留备份中的收藏夹 ID，并迁移原有视频关系。
- 2.0.3 第一轮修复了播放器筛选面板中已删除的 `actions` 容器引用；真实环境反馈继续发现同一重构区域残留的旧方案选择器引用。
- 2.0.4 修复：彻底移除旧的 `refreshProfileOptions`、`saveFilterProfile`、`deleteSelectedProfile` 及其调用，解决筛选面板初始化错误；方案管理功能仍由随机探索弹窗负责。
- 2.0.5 已发现的潜在瓶颈（真实根因尚未确认）：全盘候选抽取仅有 2 个 worker，且每个候选结果都额外调用一次 `resolveAccountId()`（跨 API 域账号身份请求），候选抽取请求与账号校验串联，降低宫格补充速度。
- 2.0.5 优化：候选抽取并发提升至 4；账号身份校验改为每 12 个候选结果检查一次，仍保留每批开始前的账号校验；首条候选仍立即启动播放器，不等待整批候选抽取完成。
- 新增自动化回归测试：模拟候选请求延迟，验证 4 路并发真实重叠、并发上限为 4，且达到 16 个候选目标时仅触发一次批内身份复核（加上批次开始时共 2 次）。
- 用户明确：真实 115 环境测试由用户安装后自行完成；助手不登录/扫码/执行真实账号测试。
- 旧版 v0.12.4、v1.9.1、2.0.1、2.0.2、2.0.3、2.0.4 历史快照保持不变。

## 最近一次验证证据（2026-11-08）
- `node --check userscripts/115-multiview-random-v2.user.js` 与 meta 文件语法检查通过。
- `npm test`：223/223 tests passed，0 failures。
- `npm run build` 成功生成 6 个脚本；v2.0.5 产物 454,731 bytes。
- `npm run check` 通过，包含全量测试与历史快照检查。
- 专项测试确认候选抽取 4 路并发、最大并发受控，账号身份校验按间隔触发。
- 代码修复与构建通过不等于真实 115 账号验收；用户自行完成真实环境验收。
## 2.0 里程碑
权威计划见 `docs/RANDOM-PLAYBACK-V2-IMPLEMENTATION.md`。
- M1 随机 API 适配器与纯随机引擎：已完成。
- M2 统一来源配置与文件夹选择器：自动化验证已完成；真实 115 体验由用户验收。
- M3 核心播放、失败跳过、补充队列、锁定窗口、新轮次：主要逻辑和行为测试已完成。
- M4 保存方案与排序：已完成；保存/置顶/手动排序/删除及 JSON 备份排序字段已实现。
- M5 本地 JSON 导出/导入与结构校验：已实现；云端自动备份延期 2.1。
- M6 旧索引写入/扫描/UI/播放依赖移除：已完成；仅保留旧收藏只读兼容查询。
- M7 自动化检查、独立构建、差异审查、提交推送和 Pages 部署：已完成。


## 已确认产品规则

- 当前线上版本：2.0.4；待发布修复版本：2.0.5。
- 安装入口：`https://huntian0727.github.io/userscript-hub/userscripts/115-multiview-random-v2.user.js`
- 更新地址：`https://huntian0727.github.io/userscript-hub/userscripts/115-multiview-random-v2.meta.js`
- 真实 115 验收仍由用户自行执行；未反馈前不得宣称真实账号验证已完成。
- 多来源按 115 文件 ID 去重，不做内容哈希。文件夹模式支持一个或多个文件夹，默认递归子文件夹；全盘模式忽略文件夹选择。- 关键词按视频文件名 OR 匹配；排除词本地过滤；支持最小/最大文件大小。
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

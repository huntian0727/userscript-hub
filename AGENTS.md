# 115 多宫格播放器 2.0 — Agent 工作规则

## 每次开始工作前
1. 先读根目录 `DEV-CURRENT.md`，确认当前唯一开发现场。
2. 再读 `DEV-RECOVERY.md`，需要恢复上下文时严格按其中的 WebCodex Session 流程执行。
3. 读取 `docs/RANDOM-PLAYBACK-V2-IMPLEMENTATION.md`，它是 2.0 产品范围、架构和里程碑的权威记录。
4. 重新核实 Runner、Project、工作树路径、分支、HEAD、Git dirty 状态和活动 Job；文档与实时状态不一致时，以实时检查为准并更新检查点。

## 中断恢复规则
- 不把 ChatGPT 聊天记录、模型记忆或旧回复当作代码状态的权威来源。
- 优先通过 WebCodex 原生 Session：对精确 Project 执行 `list_sessions`，明确选择一个返回的 Session，再执行 `read_session_handoff`；Active Session 才能通过 `work_on_project(session_id=...)` 恢复。Closed Session 仅供历史查阅。
- handoff 是恢复线索，不是当前文件系统快照。恢复后必须重新核对 Git 状态、关键文件和活动 Job。
- Job 为 pending/running/outcome_unknown 时，保留原 Job 身份并观察；不得重新派发同一任务。

## 检查点纪律
- 采用小批次检查点：每完成一个可独立验证的功能切片/一组修改及其验证，就立即更新；不等整个 M 阶段结束。每次准备结束长任务、每次预计可能中断前也必须更新：
  1. 更新 `DEV-CURRENT.md`；
  2. 向 `docs/DEV-LOG.md` 追加一条记录（只追加，不改写历史）；
  3. 在当前 WebCodex Session 中记录 progress/decision 消息；
  4. 记录准确的 Git 分支、HEAD、dirty 文件、测试命令与结果、证据新鲜度、未完成事项、下一步。
- 如果检查点写入失败，必须在最终回复中明确说明，不得声称恢复机制已完整落盘。
- 不要为了制造检查点而擅自提交代码；Git commit 只在任务需要且授权明确时进行。

## 保护规则
- 保留已有未提交修改；禁止未经明确授权执行 reset、clean、discard、覆盖或批量删除。
- 不修改 v0.12.4、v1.9.0、v1.9.1 等历史发布快照。
- 不提交、推送、合并、发布或部署，除非用户明确提出。
- 2.0 仅提供本地 JSON 导出/导入；用户可手动上传到 115 目录 `拉面多宫格播放器/配置备份`。没有可核实的官方公开 API/授权前，禁止调用未公开上传接口或宣称自动云备份。备份不得保存 Cookie、Token、账号凭据、播放 URL 或视频内容。
- 产品决策以 `docs/RANDOM-PLAYBACK-V2-IMPLEMENTATION.md` 为准；如用户明确改变决策，先更新决策文档再实施。

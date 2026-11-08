# 115 多宫格播放器 2.0 — 中断恢复操作手册

目标：ChatGPT 对话可以中断或更换，但开发现场、代码改动和下一步不能丢。恢复时以 WebCodex Session ledger + 当前检查点 + Git 实时状态三者交叉核对。

## 固定项目定位
- Runner：HOME，client_id：`mp2t8qb5-664698f51f0940b3`
- Project：`agent:mp2t8qb5-664698f51f0940b3:115-v1-0-0-3d603680-9ba27f05`
- 工作树：`C:\Users\test\.webcodex-worktrees\115-v1-0-0-3d603680`
- 分支：`develop/random-playback-v2.0`
- 当前检查点：根目录 `DEV-CURRENT.md`
- 产品/架构计划：`docs/RANDOM-PLAYBACK-V2-IMPLEMENTATION.md`

## 标准恢复流程
1. **确认 Runner 在线**：对固定 client_id 执行 `get_runtime_status`。若 Runner 离线，先恢复 HOME Runner 连接，不要新建替代工作树。
2. **定位 Project**：优先使用上面的 canonical Project ID；若不可用，按 client_id 搜索 Project 资源，确认名称、路径、分支和工作树后再继续。
3. **找 Session**：对精确 Project 执行 `list_sessions(project=...)`。优先筛选 Active；必须阅读返回标题并由模型明确选择，不可只凭“最新”猜测。找不到 Active 时可查看 Closed 历史，但 Closed 只能用于恢复历史上下文，不能继续执行。
4. **读取交接**：对明确选中的 Session 执行 `read_session_handoff(session_id=..., include_workspace=true, include_checkpoints=true, include_validation=true)`。检查 handoff 的 basis、truncation、warnings、workspace continuity、Jobs、validation freshness。
5. **恢复 Session**：只有 Active Session 才调用 `work_on_project(session_id=..., instruction=...)`。这会恢复该 Session 绑定的原 Project；不要把其他 Runner/Project 的 session_id 混用。
6. **交叉核验**：重新读取 `DEV-CURRENT.md`、2.0 实施计划、Git status 和本次要修改的文件。handoff 是有价值的交接证据，但不是文件系统实时快照。
7. **继续执行**：从 handoff 的 next actions 与 `DEV-CURRENT.md` 的下一步中取交集；如果二者冲突，以重新核验后的实际代码为准，并先更新检查点。

## Job 恢复规则
- 若 handoff 显示活动 Job，保留原 Job ID / observation_ref，调用 `observe_jobs` 观察原任务。
- pending/running/unknown/outcome_unknown 都不允许重新派发相同操作。
- 只有确认原 Job 已终止且检查实际结果后，才决定是否需要新任务。
- 终止状态不等于成功；必须检查退出码、日志和产物。

## Session 不可用时
- 若 Session 列表没有 Active Session，读取 Closed Session handoff 仅用于找回历史背景。
- 然后在同一个 canonical Project 上创建新 Session，并在启动指令中明确引用检查点和 Closed handoff；不得新建工作树，不得改变 branch/base。
- 若 Project 身份无法确认，停止写操作，只做 Runner/Project 只读发现，直到确认唯一工作树。

## 每个功能切片结束及暂停/中断前的最小动作
1. 每完成一组可独立验证的修改就更新 `DEV-CURRENT.md`：状态、branch/HEAD、dirty 文件、最新验证、下一步；不要等整个 M 阶段结束。
2. 追加 `docs/DEV-LOG.md`：本次做了什么、改了哪些文件、验证结果、风险。
3. 在当前 Session 记录一条 progress 消息，便于下次从 ledger 找到工作。
4. 如果有活动 Job，记录原 Job ID / observation_ref 和下一次观察方式。
5. 不为了“保存进度”擅自 commit、push 或发布；未提交工作由 Git 工作树保留。当前用户已明确授权 2.0 独立发布，可在完成验证和审查后提交/推送/合并。真实 115 测试由用户安装后自行完成，不得由助手登录或扫码，也不得阻塞发布。

## 新对话可直接使用的恢复指令
```text
继续 115 多宫格播放器 2.0。不要依赖旧聊天摘要猜测状态。
请先读取项目根目录 DEV-CURRENT.md、DEV-RECOVERY.md 和 docs/RANDOM-PLAYBACK-V2-IMPLEMENTATION.md；
确认 HOME Runner 和精确 Project；执行 list_sessions，明确选择 Active Session；
读取 read_session_handoff（包含 workspace/checkpoints/validation），然后恢复原 Session。
重新核对 Git branch、HEAD、dirty 文件和活动 Job，保护所有未提交修改。
从检查点的“下一步”继续开发。每完成一个里程碑或准备中断前，更新检查点、追加开发日志并记录 Session progress。
用户已明确授权尽快发布 2.0：完成自动化验证、审查和独立入口核对后，可提交/推送/合并到 main 并发布；旧版入口和历史快照不得修改。真实 115 测试由用户自行完成。
```

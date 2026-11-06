# 拉面视频宇宙 v0.2.7 — 真实模式优先与只读扫描

交付编号 VU-027-01，独立分支 experiment/video-universe-real-first-v0.2.7，基于公开 v0.2.6 开发。

## 本次交付
- 首次启动直接进入真实115模式和真实空状态，不再自动填充虚构的演示星球；演示星图保留为手动按钮。
- 自动读取当前115页面的 CID；没有可识别 CID 时从根目录 0 开始。用户仍可编辑起点目录。
- 目录请求显式指定 cur=1，只读取当前目录；record_open_time=0，避免请求时顺带记录目录打开时间；移除 natsort=1，避免特定目录仅返回统计而不返回列表的风险。
- 识别真实文件字段 isv=1；保留 fid/pickcode/size/thumbnail 的原有校验。
- 80个目录作为单批次上限；批次结束保留剩余队列，可继续；选择未探索星球会把该星球及未扫描子目录优先排入队列。
- 300颗星球的画面容量上限；超过容量的目录会明确显示未展示数量；超过探索深度的子目录也会明确显示。
- 401/403、429、911、人机验证及5xx返回明确提示。所有目录接口仍是 GET，只读；不访问/持久化 Cookie，不修改网盘文件。

## 测试
- node --check userscripts/115-video-universe.user.js
- node --test tests/115-video-universe.test.js
- node experiments/video-universe-v0.2.7/run-real-api-contract-smoke.js：Chrome中以确定性模拟的115 API响应验证真实模式启动、CID分页、文件字段、pickcode官方播放页、只读查询参数和非演示状态。\n- node experiments/video-universe-v0.2.7/run-batch-resume-smoke.js：模拟81个子目录，验证80目录批次暂停、继续按钮和82次只读请求最终全部扫描完成。
- node experiments/video-universe-v0.2.6/run-diagnostics-smoke.js：HLS失败归类/重试和真实空状态启动回归。
- node experiments/video-universe-v0.2.5/run-motion-smoke.js：HLS短预览回归。
- node experiments/video-universe-v0.2.4/run-posters-smoke.js：封面、星球点击交互回归。
- npm run check：全仓回归及不可变历史快照。

## 真实账号验收边界
以上 Chrome 测试使用模拟115响应，不登录账号、不访问私人网盘、不下载视频。真实目录是否能读取、115当前账号的pickcode是否能打开官方播放器，仍需在HOME电脑已登录的115页面完成最终验收。用户回家后只需安装中心更新到 v0.2.7，打开115并点击“探索真实115宇宙”。

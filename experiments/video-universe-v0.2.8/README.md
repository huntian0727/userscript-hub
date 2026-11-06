# 拉面视频宇宙 v0.2.8 — 真实会话诊断与扫描进度

交付编号 VU-028-01，独立分支 experiment/video-universe-session-v0.2.8，基于公开 v0.2.7 开发。

## 本次交付
- 新增真实115会话状态：未验证、验证中、已验证、需重新登录、需人机验证、请求受限、网络错误。
- 如果115目录接口返回HTML登录页，不再只显示“JSON解析失败”；提示用户先在115官方页面确认登录。
- 对401/403、302/重定向、911、人机验证、429和5xx给出不同处理；不显示原始响应体，不读取Cookie或Token。
- 新增扫描进度条：显示当前目录、分页offset/total、当前批次目录数和待探索队列。
- 请求失败后保留当前目录队列；用户完成官方登录/人机验证后点击“登录后重新尝试”或“验证后继续”即可恢复。
- 首次成功解析真实115目录响应后才显示“115会话已验证”；不通过页面变量或猜测登录状态。
- 保持v0.2.7默认真实模式、只读请求、目录批次续扫、真实文件识别和官方播放入口。

## 测试
- node --check userscripts/115-video-universe.user.js
- node --test tests/115-video-universe.test.js
- node experiments/video-universe-v0.2.8/run-session-recovery-smoke.js：模拟115返回HTML登录页，确认登录状态诊断、进度保留、重试后真实目录响应恢复；WebGL与Canvas均通过。
- node experiments/video-universe-v0.2.7/run-real-api-contract-smoke.js：真实API契约模拟。
- node experiments/video-universe-v0.2.7/run-batch-resume-smoke.js：81子目录批次续扫。
- v0.2.6 HLS、v0.2.5短预览、v0.2.4封面/交互回归均通过。
- npm run check：全仓测试与历史快照校验。

## 真实账号验收边界
浏览器测试使用模拟响应，不使用私人账号Cookie、不读取真实目录。回家后，脚本会在首次真实目录请求成功后才显示“115会话已验证”。如果需要登录或人机验证，会给出提示并保留队列；用户在115官方页面完成后再点重试。真实播放/HLS仍需在HOME登录态下确认。

# 拉面视频宇宙 v0.2.6 — 短预览错误诊断与恢复

交付编号 VU-026-01，隔离分支 experiment/video-universe-preview-ux-v0.2.6，基于公开 v0.2.5 开发。

## 本次变更
- 保留视频卫星的静态封面、默认关闭的短预览、700毫秒延迟、3秒静音HLS以及原生115播放按钮。
- 自动分类可读的失败原因：401/403 登录/权限、404 转码缺失、429 请求频繁、5xx视频服务故障，以及媒体解码、跨域网络、超时和自动播放受阻。仅向前端展示归纳的故障类型，不记录URL、pickcode、账号Cookie或原始错误对象。
- 发生短预览故障后，在星球侧边栏显示“已跳过N条失败预览”和“重新尝试”按钮；失败文件不会被无限重试刷流。点击重试清除本轮失败状态，可再悬停测试。
- HLS启用 capLevelToPlayerSize 与 maxBufferSize=4MB、短缓存，避免为190像素的小预览选择不必要的高画质/大缓冲；真实流是否支持取决于115服务及播放清单。
- 重复媒体 playing 事件只启动一次3秒计时，不会使短预览不断延期。切换页面到后台时收起悬停卡片，暂停并销毁播放流。
- 没有账户持久化、Cookie收集和视频文件写操作；旧脚本源码及历史快照保留。

## 测试
- node --check userscripts/115-video-universe.user.js
- node --test tests/115-video-universe.test.js：错误分类映射、重试开关及播放限制
- node experiments/video-universe-v0.2.6/run-diagnostics-smoke.js：WebGL/Canvas Chrome 模拟HLS成功→失败403→重试成功，以及重复playing事件和演示模式隔离
- node experiments/video-universe-v0.2.5/run-motion-smoke.js：旧版短预览回归
- node experiments/video-universe-v0.2.4/run-posters-smoke.js：静态海报及旧交互回归
- npm run check：全仓回归与不可变历史快照校验

## 真实账号待验收
在已登录的 https://115.com 上选择有真实pickcode的目录星球，开启短预览，悬停卫星；若失败，查看“已跳过N条失败预览”区域错误分类，在正常登录/转码/网络条件下点击“重新尝试”后再悬停。实际视频能否播放及缓冲情况尚未用真实115账号验证。请勿分享Cookie、敏感URL或私人视频内容。

安装中心：https://huntian0727.github.io/userscript-hub/
独立脚本：https://huntian0727.github.io/userscript-hub/userscripts/115-video-universe.user.js

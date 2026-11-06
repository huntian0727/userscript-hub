# 拉面视频宇宙 v0.2.9 — 官方播放交接与自适应HLS预览

交付编号 VU-029-01，独立分支 experiment/video-universe-playback-v0.2.9，基于公开 v0.2.8 开发。

## 本次交付
- 完整播放仍由真实 pickcode 生成 115 官方播放页 URL（ct=play、ac=location、hls=1），不尝试绕过115官方播放机制。
- 可选的3秒静音悬停预览仍默认关闭，失败不影响官方播放按钮。
- HLS.js 起始档位改为 startLevel=-1，由带宽估计自动选择，不再固定第一档。
- capLevelToPlayerSize=true 并启用 ignoreDevicePixelRatio=true，按预览视频元素的CSS尺寸限制清晰度，避免190px小卡片拉取无用的高分辨率流。
- 缓冲仍严格限制：4MB、目标3秒、最大6秒、无回看缓存；manifest/level/fragment不自动重试，失败走诊断和封面回退。
- 预览状态会显示自动画质以及当前可识别的分辨率档位（如480p）；原生HLS路径显示浏览器原生。
- 不改变HLS 1.7.4固定依赖，不读取/保存Cookie，不下载视频，不写入网盘。

## 测试
- node --check userscripts/115-video-universe.user.js
- node --test tests/115-video-universe.test.js
- node experiments/video-universe-v0.2.9/run-adaptive-quality-smoke.js：Chrome模拟HLS manifest、清晰度切换、播放/失败/重试，WebGL与Canvas均通过。
- node experiments/video-universe-v0.2.9/run-hlsjs-version-smoke.js：加载仓库实际 public/vendor/hls-1.7.4.min.js 并实例化真实Hls对象，核对所有配置值。
- v0.2.8会话恢复、v0.2.7真实API契约/82目录续扫、v0.2.6诊断、v0.2.5预览、v0.2.4封面回归通过。
- npm run check：全仓测试与历史快照。

## 真实账号验收边界
HLS配置使用真实hls.js 1.7.4库核验，播放事件使用浏览器模拟；没有访问用户的私人115目录，也没有真实115视频流可供测试。最终需要在HOME已登录的115账号里确认官方播放页与3秒预览是否能实际出画面。

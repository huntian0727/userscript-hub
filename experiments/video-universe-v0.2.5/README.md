# 拉面视频宇宙 v0.2.5 — HLS 3秒动态预览试点

交付编号 VU-025-01。基于已发布 v0.2.4 独立开发，不影响 v0.12.4、全盘探索 v1.7.0 和视频宇宙旧快照。

## 功能

- 短预览开关默认关闭。用户主动开启后，在已登录115.com网页悬停真实视频卫星700毫秒，才尝试从现有网页会话按需加载视频流，不读取/储存Cookie。
- 仅支持 https://115.com/api/video/m3u8/{pickcode}.m3u8 格式，pickcode 经过4-128位字母数字验证。只有在 https://115.com 主域且非演示模式才允许发起请求。
- 静音、单路、最长3秒。鼠标移走、隐藏卫星、切换目录星球、退出界面即销毁。8秒内未准备好则超时回退静态封面。
- Chromium 使用自托管 hls.js 1.7.4（Apache-2.0），文件 public/vendor/hls-1.7.4.min.js 和许可证 public/vendor/LICENSE-hls-1.7.4.txt。
- 若浏览器媒体能力、115会话、CORS、账号权限、转码或视频格式不支持，则保持静态封面，原生“在115播放”仍然可用。

## 验收

1. node --test tests/115-video-universe.test.js：URL约束、默认关闭与演示隔离。
2. node experiments/video-universe-v0.2.5/run-motion-smoke.js：离线 Chrome 模拟 HLS，验证开关、静音播放、移开销毁、演示模式禁止；WebGL和Canvas两种模式。
3. node experiments/video-universe-v0.2.4/run-posters-smoke.js：旧版静态封面与交互回归。
4. npm run check：全仓测试、构建、快照一致性。
5. 真实115已登录账号最终测试：手动开启短预览，在拥有有效提取码的卫星上悬停，观察3秒真实画面或明确的封面回退，不提供Cookie或视频内容。

## 约束

HLS清单路径来自公开第三方 115 播放器实现，不保证属于稳定官方接口。所有自动化验证只用了**模拟HLS播放引擎**，不代表真实账号视频播放验收通过。不得覆盖旧历史快照，新增 history/115-video-universe/0.2.5.user.js。

# 视频宇宙 v0.2.1 — 单击星球自动居中

交付编号：**VU-021-01**，脚本：`115-video-universe`。在原有独立视频宇宙通道发布，绝不影响稳定版 `115-multiview-indexed` 或全盘探索版 `115-multiview-full-disk`。

## 行为

- 单击可见星球：立即更新右侧信息，开始约 900ms 平滑飞行，星球到达画面中心；之后鼠标旋转的焦点锁定在该星球。
- 左键拖动画布：只旋转，不误触发星球切换。Shift/右键平移仍正常。
- 点击空白处 / 回到全景：回到根目录中心；随机跃迁、双击聚焦、缩放及演示/真实115目录扫描保持不变。
- 未修改数据请求、收藏、旧版索引或其他播放器逻辑。只改独立视频宇宙 UI 与其测试。

## 验证

`node experiments/video-universe-v0.2.1/run-center-smoke.js` 在本机 Chrome 测试真实鼠标 PointerEvent：选中目标、开始飞行、约 900ms 后中心坐标精确匹配、相机 focus 与星球 3D 坐标一致、拖动后 focus 不变、点击空白返回全景；同时以 `UNIVERSE_FORCE_FALLBACK=1` 验证禁用 WebGL 的 Canvas 渲染。

`npm run check` 全仓库 168 项测试通过，站点及历史快照校验通过。尚未在实际登录的115账号下验证视频目录或播放；九格当前是文件样本展示，不是内嵌解码。

## 快照与回滚

- 新历史快照：`history/115-video-universe/0.2.1.user.js`，SHA-256 `1656160942c85de9a077535e6ddf75f86234b4329dbdaaf43d82abbc878441e3`。
- `history/115-video-universe/0.2.0.user.js`、`history/115-video-universe/0.1.0.user.js` 不变。
- 安装入口仍为 `https://huntian0727.github.io/userscript-hub/userscripts/115-video-universe.user.js`；随 v0.2.1 的 `@version` 在相同独立通道更新。

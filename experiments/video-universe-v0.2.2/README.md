# 拉面视频宇宙 v0.2.2 — 聚焦邻域和视频预览

交付编号 VU-022-01。独立探索版本，最初从实验分支 experiment/video-universe-orbit-v0.2.2 开发，并通过 GitHub main / Pages 独立发布；以公开安装地址实际版本为准。脚本仍使用独立 115-video-universe 标识，与旧 115-multiview-indexed（含 v0.12.4）、115-multiview-full-disk（含 1.6/1.7）完全隔离。

## 核心交互

- 点击任何 3D 星球，镜头飞行居中并停止自转。周围展开它的直接子文件夹星球；若当前是末端星球，则展开同级文件夹；没有邻居只显示本星球。
- 单页最多 12 颗，右侧上一组/下一组按钮切页。右侧列表可直接切换中心星球，动画保留平滑过渡。点击画面空白或「回到全景」恢复全宇宙。
- 视频样本不再直接跳目录：点击先在右侧显示文件名/大小及操作。有效 pickcode 才启用「在115播放」；新标签页交给115自有播放器处理。始终可选择「打开所在目录」。
- 演示模式标明模拟数据，禁止在演示数据上播放或跳到真实目录。真实目录扫描仍只读，不请求删除、不触碰原始索引/收藏数据库。
- 本试点显示信息预览图形，不加载视频首帧/缩略图，也不负责视频解码。原生115播放入口兼容性需要登录115账号实测。

## 验证

- node --check userscripts/115-video-universe.user.js
- node scripts/build-pages.js 生成静态安装文件与不可变 history/115-video-universe/0.2.2.user.js 快照
- node --test tests/115-video-universe.test.js 覆盖分组、分页、确定性3D布局、播放链接域名和无效pickcode
- npm run check 全仓库检查及快照一致性
- node experiments/video-universe-v0.2.2/run-orbit-smoke.js：Chrome WebGL 交互测试
- 环境变量 UNIVERSE_FORCE_FALLBACK=1 下同一脚本：Chrome Canvas 降级测试

以上是离线模拟验收；未完成真实115目录权限或视频播放兼容性验收。

## 发布边界

不得覆盖 v0.1.0、v0.2.0、v0.2.1 历史快照。发布仅限独立的 video-universe 安装入口，应先核验Git差异、测试及 Pages 成功部署，再宣告发布完成。旧播放器的安装地址与历史快照不变。

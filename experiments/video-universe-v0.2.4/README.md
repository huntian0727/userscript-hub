# 拉面视频宇宙 v0.2.4：视频卫星封面与悬停预览

交付编号 VU-024-01。独立视频宇宙试点版本，基于已发布的 v0.2.3 开发，不修改稳定版、1.6 系列、其他115全盘探索脚本与原有历史快照。

## 本次功能

- 只读复用115文件列表返回的 v_img、thumb 字段。经严格 HTTPS 和 115/115cdn 域名验证后，可用于视频卫星的圆形纹理、九格卡片和右侧视频详情封面。
- 没有缩略图、加载失败或遇到不可信地址时，按文件扩展名生成本地彩色格式海报，用户不会误以为这是视频实际画面。
- 鼠标悬停视频卫星，展示跟随光标的封面卡片和完整视频文件名；移出画面自动收起。点击卫星仍然打开右侧详细信息。
- 最多9颗可见视频卫星，最多24张图片在有限缓存中使用，不增加新的视频解码/下载接口，不进行账号写操作、文件清理或索引迁移。
- 仅复用已经扫描到的目录文件样本；与实际115登录账号、权限和视频封面服务有关的成功显示，需要真实账号现场验收。

## 验证

1. node --check userscripts/115-video-universe.user.js
2. node --test tests/115-video-universe.test.js
3. node experiments/video-universe-v0.2.4/run-posters-smoke.js
4. 设置 UNIVERSE_FORCE_FALLBACK=1 后重复第3步，验证无WebGL模式
5. npm run check（全仓库测试、构建与历史快照一致性）

模拟页面测试：卫星悬停卡片、动态标题、鼠标移出收起、视频详情封面容器、九格本地海报、禁用演示播放、原有星球导航和摄像机操作。未把真实115封面请求/鉴权/播放声称为已验证。

## 安装与回滚

独立入口：https://huntian0727.github.io/userscript-hub/userscripts/115-video-universe.user.js

历史版本和快照 v0.1.0、v0.2.0、v0.2.1、v0.2.2、v0.2.3 都保留，当前历史快照为 history/115-video-universe/0.2.4.user.js。发布需分别核对 GitHub main 提交、GitHub Pages 作业和公开安装清单。

字段参考： https://github.com/OpenListTeam/115-sdk-go/blob/main/fs.go （公开文件列表 SDK 类型包含 v_img 和 thumb）。

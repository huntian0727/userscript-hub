# 油猴脚本安装中心

公开的 Tampermonkey 脚本安装、更新、历史版本与 AI 接入入口。使用 GitHub Pages 托管，无需用户电脑运行本地 Node.js 服务。

## 在线入口

- 安装中心：https://huntian0727.github.io/userscript-hub/
- AI 快速发现：https://huntian0727.github.io/userscript-hub/llms.txt
- AI 接入规范：https://huntian0727.github.io/userscript-hub/ai-integration.md
- 机器可读配置：https://huntian0727.github.io/userscript-hub/api/integration.json
- 脚本清单：https://huntian0727.github.io/userscript-hub/api/manifest.json

## 当前公开脚本

| 脚本 | 当前状态 |
|---|---|
| 115 多画面播放器（四宫格验证版） v0.1.1 | 公开迁移验证版 |
| 115 多画面播放器 · 目录索引验证版 v0.3.0 | 公开开发验证版 |
| 115 多画面播放器 · 索引驱动多宫格 v0.8.2 | 统一测试安装中心 · 智能画幅与工具栏优化 |

本安装中心是统一测试与体验入口。每个通过自动化测试的新版本都会直接发布到这里，用户可随时安装体验；历史版本保留，不覆盖已有版本。

## 发布方式

1. 只将明确批准公开的完整 .user.js 放入 userscripts/。
2. 在 registry.json 中登记脚本白名单，不自动扫描或导入其他脚本。
3. 修改脚本时递增元数据头中的 @version。
4. 在仓库根目录执行 node scripts/build-pages.js。
5. 运行 node --test tests/*.test.js，检查生成的 site/。
6. 将源文件、登记信息和新增历史快照提交到 main。
7. GitHub Actions 自动构建并部署 GitHub Pages。

GitHub Actions 使用 node scripts/build-pages.js --check-history，不会在 CI 中偷偷创建未提交的历史快照。

## 历史版本

history/<script-id>/<version>.user.js 是不可覆盖的发布快照。相同脚本、相同版本若代码发生变化，构建会失败，必须先递增 @version。

## 安全边界

- 本仓库是公开仓库；userscripts/、history/、构建产物和文档均可被任何人访问。
- 只发布 registry.json 明确启用且已获准公开的脚本。
- 不得放入 Cookie、Token、账号凭据、个人路径、私人脚本、内部文档或测试数据。
- GitHub Pages 只托管静态文件，不运行 Node.js 服务端代码。
- 安装和更新仍由 Tampermonkey 正常处理；不会绕过用户确认。
- GitHub Actions 只负责校验、构建和部署，不访问 115 用户登录态或私人数据。

## 公开版本说明

首次公开迁移时，原四宫格验证版和目录索引验证版分别使用 v0.1.1、v0.2.1，以便识别更新；此前版本快照继续保留。目录索引验证版后续已更新至 v0.3.0。

索引驱动播放器首次公开测试版本为v0.2.0，v0.2.1增加未完成索引时播放已保存部分，v0.3.0增加2/4/6/9/12宫格和窗口控制，v0.4.0增加随机换片与锁定保护，v0.6.0增加最近目录、布局/筛选记忆和收藏管理，v0.7.0优化多宫格分级缓冲与隐藏窗口请求回收，当前更新至v0.8.2（保留主副屏布局、组合筛选、自定义换片、排除恢复、播放控制、JSON备份恢复、单一声音来源、全屏声音交接和最近目录清理；修复智能画幅自适应，并优化工具栏空间与低频设置收纳）。测试版和正式版统一通过本安装中心发布，自动化测试通过后直接更新，历史版本永久保留。

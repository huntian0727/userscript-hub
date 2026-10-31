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
| 115 多画面播放器（四宫格验证版） | 验证体验版 |
| 115 多画面播放器 · 目录索引验证版 | 开发验证版 |

以上两个脚本目前均为验证版本，页面会明确标识，不应误认为正式稳定版。

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

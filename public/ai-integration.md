# 油猴脚本安装中心：AI 接入规范

版本：1.0.0  
平台：Public Userscript Hub  
在线地址：{{BASE_URL}}/  
公开仓库：{{REPOSITORY_URL}}  
仓库标识：{{REPOSITORY_FULL_NAME}}

## 1. 平台定位

这是一个通过 GitHub Pages 托管的公开 Tampermonkey 用户脚本安装中心。它为多个开发项目提供统一的脚本登记、安装、更新、版本留档和历史版本入口。使用者无需在本地部署 Node.js 服务。

## 2. AI 首次接入顺序

1. 读取 {{BASE_URL}}/llms.txt。
2. 读取 {{BASE_URL}}/api/integration.json，获取仓库标识、登记文件、构建命令、脚本相对路径和公开地址。
3. 读取 {{BASE_URL}}/api/manifest.json，核对当前脚本清单和版本。
4. 需要查看源代码时，读取 {{REPOSITORY_URL}} 对应仓库中的 userscripts/ 文件。

机器可读配置是当前发布地址和脚本清单的权威来源。不要猜测仓库路径或硬编码历史版本。

## 3. 架构与访问

- 网站由 GitHub Pages 提供静态托管。
- 自动构建由 GitHub Actions 执行。
- 仓库：{{REPOSITORY_URL}}
- 仓库标识：{{REPOSITORY_FULL_NAME}}
- 默认分支：main
- 页面基址：{{BASE_URL}}
- 无需本机 Node.js HTTP 服务。
- 所有仓库文件、脚本和历史版本公开可见。

## 4. 项目结构

| 路径 | 用途 |
|---|---|
| registry.json | 明确批准公开的脚本白名单 |
| userscripts/ | 脚本源代码，仅放获准公开的 .user.js |
| history/ | 不可覆盖的版本快照 |
| public/ | 安装中心页面与 AI 文档源文件 |
| scripts/build-pages.js | 生成静态站点、manifest、AI 配置及历史产物 |
| tests/ | Node.js 内置测试 |
| .github/workflows/deploy-pages.yml | 自动校验和 GitHub Pages 部署 |
| site/ | 自动生成的静态发布目录，不直接手工编辑 |

## 5. 新脚本接入流程

只有用户明确要求公开某个脚本时，才可以把它加入公开仓库。不要扫描其他项目或本机目录后批量导入。

1. 核对目标项目、脚本用途和 Git 工作区。
2. 确认用户批准公开该脚本的源码和历史版本。
3. 检查源码中没有 Cookie、Token、账号凭据、个人路径、私人数据或无关内部信息。
4. 将完整脚本复制到 userscripts/。
5. 在 registry.json 中新增唯一 id 和 source 路径，enabled 设为 true。
6. 新脚本首次发布时核对 @name、@namespace、@version；后续修改必须递增 @version。
7. 运行 node scripts/build-pages.js，生成不可覆盖的 history 快照和 site/。
8. 运行 node --test tests/*.test.js。
9. 核对 site/api/manifest.json、site/api/integration.json、安装地址、更新地址和历史地址。
10. 经用户批准后提交并推送 main；GitHub Actions 自动部署。

## 6. 版本与历史保护

- 每个脚本使用稳定 id。
- 修改源代码必须递增 @version。
- 构建时自动注入 HTTPS @updateURL 和 @downloadURL。
- history/<id>/<version>.user.js 首次生成后不可覆盖。
- 同一版本内容发生变化时构建必须失败。
- GitHub Actions 使用 --check-history，只验证已提交快照，不在 CI 中隐式补写历史。
- 旧版本继续保留并由安装中心提供回退入口。

## 7. Tampermonkey 安装与更新

- 安装地址：{{BASE_URL}}/userscripts/{id}.user.js
- 更新元数据：{{BASE_URL}}/userscripts/{id}.meta.js
- 下载地址：{{BASE_URL}}/userscripts/{id}.user.js
- 安装脚本内的 @updateURL 和 @downloadURL 均使用固定 HTTPS 地址。
- 安装和更新仍由 Tampermonkey 正常显示确认界面；不支持静默安装。
- 网页无法读取 Tampermonkey 内部安装列表，不得虚报安装状态。

## 8. 自动部署

源文件、registry.json 和 history 快照提交到 main 后，GitHub Actions 会：

1. 检出仓库。
2. 使用 Node.js 22。
3. 运行 node --test tests/*.test.js。
4. 运行 node scripts/build-pages.js --check-history。
5. 上传 site/ 静态构建产物。
6. 部署 GitHub Pages。

不要直接编辑 site/；它是构建产物。

## 9. 安全规则

- 本仓库和 GitHub Pages 均为公开状态。
- 只发布用户明确批准公开的脚本。
- 禁止上传 Cookie、Token、密码、密钥、私人脚本、个人路径、内部业务文档和真实用户数据。
- 不要把整个本机油猴脚本目录复制到本仓库。
- GitHub Pages 只有静态读取能力，不提供 HTTP 文件写入、脚本登记、命令执行或构建触发接口。
- 不擅自修改仓库可见性、删除历史版本或发布未批准脚本。
- 不要把脚本的测试版本描述为正式稳定版。

## 10. 给新 AI 项目的指令

请先访问 {{BASE_URL}}/llms.txt，阅读公开油猴脚本安装中心的接入规范，并读取 {{BASE_URL}}/api/integration.json 和 {{BASE_URL}}/api/manifest.json。后续如需将本项目脚本加入该平台，先核验脚本内容和公开范围，再按仓库白名单、版本、历史快照、测试和 GitHub Actions 部署流程执行。不要导入私人脚本或无关项目文件。

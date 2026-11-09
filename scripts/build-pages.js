'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEFAULT_BASE_URL = 'https://huntian0727.github.io/userscript-hub';
const ROOT = path.resolve(__dirname, '..');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function getPublishedAt(rootDir, filePath) {
  const relativePath = path.relative(rootDir, path.resolve(filePath)).split(path.sep).join('/');
  if (!relativePath || relativePath === '..' || relativePath.startsWith('../') || path.isAbsolute(relativePath)) {
    return null;
  }
  try {
    const status = execFileSync('git', [
      'status', '--porcelain', '--untracked-files=all', '--', relativePath
    ], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (status) return null;

    const committedAt = execFileSync('git', [
      'log', '-1', '--format=%cI', '--', relativePath
    ], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const date = new Date(committedAt);
    return committedAt && Number.isFinite(date.getTime()) ? date.toISOString() : null;
  } catch {
    return null;
  }
}
function copyDirectory(sourceDir, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const name of fs.readdirSync(sourceDir)) {
    const sourcePath = path.join(sourceDir, name);
    const destinationPath = path.join(destinationDir, name);
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink()) throw new Error('Refusing to publish a symbolic link: ' + sourcePath);
    if (stat.isDirectory()) copyDirectory(sourcePath, destinationPath);
    else if (stat.isFile()) fs.copyFileSync(sourcePath, destinationPath);
    else throw new Error('Refusing to publish a non-regular file: ' + sourcePath);
  }
}
function isInside(base, target) {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function readMetadata(source) {
  const match = source.match(/^\/\/ ==UserScript==\r?\n[\s\S]*?^\/\/ ==\/UserScript==/m);
  if (!match) throw new Error('Missing userscript metadata header');
  const header = match[0];
  function field(name) {
    const line = header.match(new RegExp('^//\\s*@' + name + '\\s+(.+?)\\s*$', 'm'));
    return line ? line[1].trim() : '';
  }
  const metadata = {
    header,
    name: field('name'),
    namespace: field('namespace'),
    version: field('version'),
    description: field('description')
  };
  if (!metadata.name || !metadata.namespace || !metadata.version) {
    throw new Error('Userscript must define @name, @namespace and @version');
  }
  if (!/^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(metadata.version)) {
    throw new Error('Unsupported @version format: ' + metadata.version);
  }
  return metadata;
}

function assertNoEmbeddedSecrets(source, label) {
  const checks = [
    ['private key', /-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP) PRIVATE KEY-----/],
    ['GitHub token', /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/],
    ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
    ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
    ['bearer credential', /\bBearer\s+[A-Za-z0-9._~+/-]{24,}/i],
    ['literal API credential', /\b(?:client_secret|api_key|access_token|refresh_token)\s*[:=]\s*['"][A-Za-z0-9._~+/-]{16,}['"]/i],
    ['personal Windows path', /[A-Z]:\\Users\\[^\\]+\\/i]
  ];
  for (const [name, pattern] of checks) {
    if (pattern.test(source)) throw new Error('Public source scan detected ' + name + ' in ' + label);
  }
}

function resolveSource(rootDir, userscriptsDir, relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath) || !relativePath.endsWith('.user.js')) {
    throw new Error('Registry source must be a relative .user.js path');
  }
  const candidate = path.resolve(rootDir, relativePath);
  if (!isInside(rootDir, candidate) || !isInside(userscriptsDir, candidate)) {
    throw new Error('Registry source must remain inside userscripts/');
  }
  const real = fs.realpathSync(candidate);
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !isInside(userscriptsDir, real) || !fs.statSync(real).isFile()) {
    throw new Error('Registry source must be a regular file inside userscripts/');
  }
  return real;
}

function withUpdateUrls(source, id, baseUrl) {
  const metadata = readMetadata(source);
  const updateUrl = baseUrl + '/userscripts/' + id + '.meta.js';
  const downloadUrl = baseUrl + '/userscripts/' + id + '.user.js';
  const lines = metadata.header.split(/\r?\n/)
    .filter(line => !/^\/\/\s*@(updateURL|downloadURL)\b/i.test(line));
  lines.splice(lines.length - 1, 0,
    '// @updateURL   ' + updateUrl,
    '// @downloadURL ' + downloadUrl
  );
  const newline = metadata.header.includes('\r\n') ? '\r\n' : '\n';
  const header = lines.join(newline);
  return {
    content: source.replace(metadata.header, header),
    header,
    updateUrl,
    downloadUrl,
    metadata
  };
}

function readHistory(historyDir, id, baseUrl, rootDir) {
  const directory = path.join(historyDir, id);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter(name => /^[0-9A-Za-z.+_-]+\.user\.js$/.test(name))
    .map(name => {
      const filePath = path.join(directory, name);
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Invalid history file: ' + name);
      const version = name.slice(0, -'.user.js'.length);
      const bytes = fs.readFileSync(filePath);
      return {
        version,
        publishedAt: getPublishedAt(rootDir, filePath),
        url: baseUrl + '/history/' + id + '/' + encodeURIComponent(version) + '.user.js',
        sizeBytes: bytes.length,
        sha256: sha256(bytes)
      };
    })
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

function safeWriteSnapshot(rootDir, filePath, bytes, checkHistory) {
  if (!isInside(rootDir, filePath)) throw new Error('History snapshot escaped repository root');
  if (fs.existsSync(filePath)) {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Invalid existing history snapshot');
    const oldHash = sha256(fs.readFileSync(filePath));
    const nextHash = sha256(bytes);
    if (oldHash !== nextHash) {
      throw new Error('History snapshot already exists with different content: ' + path.relative(rootDir, filePath) +
        '. Increment the source userscript @version before rebuilding.');
    }
    return;
  }
  if (checkHistory) {
    throw new Error('Missing committed history snapshot: ' + path.relative(rootDir, filePath) +
      '. Run node scripts/build-pages.js locally and commit the new snapshot.');
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes, { flag: 'wx' });
}

function buildPages(options = {}) {
  const rootDir = path.resolve(options.rootDir || ROOT);
  const registryPath = path.join(rootDir, 'registry.json');
  const userscriptsDir = path.join(rootDir, 'userscripts');
  const historyDir = path.join(rootDir, 'history');
  const publicDir = path.join(rootDir, 'public');
  const outputDir = path.resolve(options.outputDir || path.join(rootDir, 'site'));
  const baseUrl = String(options.baseUrl || process.env.PAGES_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const checkHistory = Boolean(options.checkHistory);

  const parsedBase = new URL(baseUrl);
  if (parsedBase.protocol !== 'https:' || parsedBase.search || parsedBase.hash) {
    throw new Error('PAGES_BASE_URL must be an HTTPS URL without query or fragment');
  }
  if (!isInside(rootDir, outputDir) || outputDir === rootDir || path.basename(outputDir) !== 'site') {
    throw new Error('Build output must be the isolated site/ directory inside the repository');
  }
  if (!fs.existsSync(registryPath) || !fs.existsSync(userscriptsDir) || !fs.existsSync(publicDir)) {
    throw new Error('Missing registry.json, userscripts/ or public/ directory');
  }

  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  if (!registry || registry.schemaVersion !== 1 || !Array.isArray(registry.scripts)) {
    throw new Error('Invalid public userscript registry');
  }
  const ids = new Set();
  const pending = [];
  for (const item of registry.scripts) {
    if (!item || (item.enabled === false && item.archive !== true)) continue;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id || '') || ids.has(item.id)) {
      throw new Error('Invalid or duplicate userscript id: ' + String(item.id));
    }
    ids.add(item.id);
    if (item.enabled === false) continue;
    const sourcePath = resolveSource(rootDir, userscriptsDir, item.source);
    const source = fs.readFileSync(sourcePath, 'utf8');
    assertNoEmbeddedSecrets(source, item.source);
    const served = withUpdateUrls(source, item.id, baseUrl);
    const artifact = Buffer.from(served.content, 'utf8');
    const metaArtifact = Buffer.from(served.header + '\n', 'utf8');
    const snapshotPath = path.join(historyDir, item.id, served.metadata.version + '.user.js');
    pending.push({ item, sourcePath, publishedAt: getPublishedAt(rootDir, sourcePath), served, artifact, metaArtifact, snapshotPath });
  }
  for (const entry of pending) safeWriteSnapshot(rootDir, entry.snapshotPath, entry.artifact, checkHistory);

  const repository = registry.repository || {};
  const owner = process.env.GITHUB_REPOSITORY_OWNER || repository.owner || 'huntian0727';
  const repoName = process.env.GITHUB_REPOSITORY
    ? process.env.GITHUB_REPOSITORY.split('/')[1]
    : (repository.name || 'userscript-hub');
  const repoFullName = owner + '/' + repoName;
  const repositoryUrl = 'https://github.com/' + repoFullName;
  const cloneUrl = repositoryUrl + '.git';
  const defaultBranch = repository.defaultBranch || 'main';

  const scripts = pending.map(entry => {
    const history = readHistory(historyDir, entry.item.id, baseUrl, rootDir);
    return {
      id: entry.item.id,
      displayName: entry.item.displayName || entry.served.metadata.name,
      name: entry.served.metadata.name,
      namespace: entry.served.metadata.namespace,
      version: entry.served.metadata.version,
      description: entry.item.description || entry.served.metadata.description,
      channel: entry.item.channel || '公开体验',
      publishedAt: entry.publishedAt,
      sizeBytes: entry.artifact.length,
      sha256: sha256(entry.artifact),
      sourcePath: entry.item.source,
      installUrl: baseUrl + '/userscripts/' + entry.item.id + '.user.js',
      updateUrl: baseUrl + '/userscripts/' + entry.item.id + '.meta.js',
      downloadUrl: baseUrl + '/userscripts/' + entry.item.id + '.user.js',
      history
    };
  });

  const generatedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    hubName: registry.hubName || '油猴脚本安装中心',
    hubVersion: registry.hubVersion || '1.0.0',
    generatedAt,
    baseUrl,
    repository: { fullName: repoFullName, url: repositoryUrl, defaultBranch },
    scripts
  };

  const integration = {
    schemaVersion: 1,
    protocol: 'public-userscript-hub-ai-integration',
    protocolVersion: '1.0.0',
    service: 'userscript-hub',
    status: 'ready',
    hosting: 'github-pages',
    hubName: manifest.hubName,
    hubVersion: manifest.hubVersion,
    baseUrl,
    repository: {
      fullName: repoFullName,
      url: repositoryUrl,
      cloneUrl,
      defaultBranch,
      registryFile: 'registry.json',
      workflowFile: '.github/workflows/deploy-pages.yml'
    },
    project: {
      sourceDirectory: 'userscripts/',
      registryFile: 'registry.json',
      buildCommand: 'node scripts/build-pages.js',
      validationCommand: 'node --test tests/*.test.js',
      outputDirectory: 'site/',
      historyDirectory: 'history/',
      sourcePathsRelativeToRepository: true
    },
    discovery: {
      homepage: baseUrl + '/',
      quickStart: baseUrl + '/llms.txt',
      integrationGuide: baseUrl + '/ai-integration.md',
      machineReadable: baseUrl + '/api/integration.json',
      scriptManifest: baseUrl + '/api/manifest.json',
      repository: repositoryUrl,
      rawRegistry: 'https://raw.githubusercontent.com/' + repoFullName + '/' + defaultBranch + '/registry.json'
    },
    capabilities: {
      publicRead: true,
      readScriptManifest: true,
      readRegisteredScript: true,
      readHistoricalVersion: true,
      registerScriptViaHttp: false,
      modifySourceViaHttp: false,
      triggerBuildViaHttp: false,
      installSilently: false,
      requiresLocalNodeServer: false,
      exposesReleaseTimestamps: true
    },
    workflow: [
      'Read /llms.txt, /ai-integration.md and /api/integration.json before integrating.',
      'Use repository.fullName and project.registryFile from this descriptor; do not guess local paths.',
      'Only add scripts explicitly approved for public distribution to userscripts/ and registry.json.',
      'Inspect the exact source for credentials, private paths, cookies, personal data and unintended capabilities before publication.',
      'Increment the source userscript @version before changing the contents of an existing release.',
      'Run node scripts/build-pages.js locally to create an immutable history snapshot and generate site/.',
      'Run node --test tests/*.test.js and verify generated manifest/install URLs.',
      'Commit source, registry and history snapshot to the main branch; GitHub Actions builds and deploys GitHub Pages.',
      'Never commit secrets; never silently install; preserve Tampermonkey user confirmation.'
    ],
    rules: [
      'This is a public repository and public website; every committed file and published history snapshot is visible to everyone.',
      'Only explicitly registered and approved public userscripts are distributed.',
      'Do not add private scripts, credentials, cookies, personal data, internal project files or unrelated backups.',
      'HTTP hosting is static and read-only; it has no file-write, registration, command-execution or build-trigger endpoint.',
      'Tampermonkey installation and update use fixed HTTPS URLs and retain normal user confirmation.',
      'Do not publish a new script or materially change publication scope without user approval.'
    ],
    endpoints: [
      { method: 'GET', path: '/', purpose: 'Public installation hub' },
      { method: 'GET', path: '/llms.txt', purpose: 'AI quick discovery instructions' },
      { method: 'GET', path: '/ai-integration.md', purpose: 'Full AI integration guide' },
      { method: 'GET', path: '/api/integration.json', purpose: 'Machine-readable integration descriptor' },
      { method: 'GET', path: '/api/manifest.json', purpose: 'Current public script manifest' },
      { method: 'GET', path: '/userscripts/{id}.user.js', purpose: 'Tampermonkey install/update package' },
      { method: 'GET', path: '/userscripts/{id}.meta.js', purpose: 'Tampermonkey update metadata' },
      { method: 'GET', path: '/history/{id}/{version}.user.js', purpose: 'Immutable historical package' }
    ],
    scripts
  };

  const llms = [
    '# 油猴脚本安装中心（Public Userscript Hub）',
    '',
    '> 公开的 Tampermonkey 用户脚本安装、更新、历史版本和 AI 接入平台。使用 GitHub Pages 托管，不需要用户电脑运行本地 Node.js 服务。',
    '',
    '## AI 首次接入',
    '',
    '1. 阅读本文件。',
    '2. 阅读 ' + baseUrl + '/ai-integration.md。',
    '3. 获取机器可读配置：' + baseUrl + '/api/integration.json。',
    '4. 获取当前脚本清单：' + baseUrl + '/api/manifest.json。',
    '5. 浏览公开仓库：' + repositoryUrl + '。',
    '',
    '## 固定入口',
    '',
    '- 首页：' + baseUrl + '/',
    '- AI 快速发现：' + baseUrl + '/llms.txt',
    '- 完整接入规范：' + baseUrl + '/ai-integration.md',
    '- 机器可读配置：' + baseUrl + '/api/integration.json',
    '- 脚本清单：' + baseUrl + '/api/manifest.json',
    '- GitHub 仓库：' + repositoryUrl,
    '',
    '## 安全边界',
    '',
    '- 所有仓库文件、脚本和历史版本均公开可见。',
    '- 只发布明确登记并批准公开的脚本。',
    '- 不要上传 Cookie、Token、账号凭据、个人路径、私人脚本或内部资料。',
    '- GitHub Pages 只提供静态读取，不开放 HTTP 写入或远程命令执行。',
    '- Tampermonkey 安装和更新保留用户确认。',
    ''
  ].join('\n');

  const guideTemplate = fs.readFileSync(path.join(publicDir, 'ai-integration.md'), 'utf8');
  const guide = guideTemplate
    .replaceAll('{{BASE_URL}}', baseUrl)
    .replaceAll('{{REPOSITORY_URL}}', repositoryUrl)
    .replaceAll('{{REPOSITORY_FULL_NAME}}', repoFullName);
  if (fs.existsSync(outputDir)) {
    const stat = fs.lstatSync(outputDir);
    if (stat.isSymbolicLink()) throw new Error('Refusing to clear a symlinked site/ output directory');
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outputDir, { recursive: true });
  copyDirectory(publicDir, outputDir);
  fs.mkdirSync(path.join(outputDir, 'api'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, '.well-known'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'userscripts'), { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'llms.txt'), llms);
  fs.writeFileSync(path.join(outputDir, 'ai-integration.md'), guide);
  fs.writeFileSync(path.join(outputDir, 'api', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(outputDir, 'api', 'integration.json'), JSON.stringify(integration, null, 2) + '\n');
  fs.writeFileSync(path.join(outputDir, '.well-known', 'ai-integration.json'), JSON.stringify(integration, null, 2) + '\n');
  fs.writeFileSync(path.join(outputDir, '.nojekyll'), '');

  for (const entry of pending) {
    fs.writeFileSync(path.join(outputDir, 'userscripts', entry.item.id + '.user.js'), entry.artifact);
    fs.writeFileSync(path.join(outputDir, 'userscripts', entry.item.id + '.meta.js'), entry.metaArtifact);
  }
  for (const id of ids) {
    const sourceHistoryDir = path.join(historyDir, id);
    if (!fs.existsSync(sourceHistoryDir)) continue;
    if (!fs.lstatSync(sourceHistoryDir).isDirectory()) throw new Error('Invalid history directory: ' + id);
    const outputHistoryDir = path.join(outputDir, 'history', id);
    fs.mkdirSync(outputHistoryDir, { recursive: true });
    for (const file of fs.readdirSync(sourceHistoryDir)) {
      if (!/^[0-9A-Za-z.+_-]+\.user\.js$/.test(file)) continue;
      const sourceHistoryPath = path.join(sourceHistoryDir, file);
      const stat = fs.lstatSync(sourceHistoryPath);
      if (!stat.isFile()) throw new Error('Invalid history file: ' + file);
      fs.copyFileSync(sourceHistoryPath, path.join(outputHistoryDir, file));
    }
  }
  return { manifest, integration, outputDir };
}

if (require.main === module) {
  try {
    const checkHistory = process.argv.includes('--check-history');
    const result = buildPages({ checkHistory });
    process.stdout.write('Built public userscript hub v' + result.manifest.hubVersion +
      ' with ' + result.manifest.scripts.length + ' scripts into site/\n');
    for (const item of result.manifest.scripts) {
      process.stdout.write('- ' + item.displayName + ' v' + item.version + ' (' + item.sizeBytes + ' bytes)\n');
    }
    process.stdout.write('Pages URL: ' + result.manifest.baseUrl + '/\n');
  } catch (error) {
    process.stderr.write('Public userscript hub build failed: ' + error.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = { buildPages, readMetadata, withUpdateUrls, assertNoEmbeddedSecrets, resolveSource, getPublishedAt };





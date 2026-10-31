'use strict';

const list = document.getElementById('script-list');
const serverState = document.getElementById('server-state');
const scriptCount = document.getElementById('script-count');
const buildTime = document.getElementById('build-time');
const refreshButton = document.getElementById('refresh-button');
const baseUrl = new URL('./', document.baseURI);

function endpoint(path) {
  return new URL(path, baseUrl).toString();
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  return (value / (1024 * 1024)).toFixed(2) + ' MB';
}

function createHistory(entry) {
  const details = node('details', 'history');
  details.append(node('summary', '', '历史版本（' + entry.history.length + '）'));
  if (!entry.history.length) {
    details.append(node('p', 'empty-history', '暂无历史版本'));
    return details;
  }
  const items = node('div', 'history-list');
  for (const version of entry.history) {
    const row = node('div', 'history-row');
    const label = node('span', '', 'v' + version.version);
    const size = node('small', '', formatBytes(version.sizeBytes));
    const link = node('a', 'history-link', '安装此版本');
    link.href = version.url;
    link.target = '_blank';
    link.rel = 'noopener';
    row.append(label, size, link);
    items.append(row);
  }
  details.append(items);
  return details;
}

function createCard(entry) {
  const card = node('article', 'script-card');
  const head = node('div', 'card-head');
  const icon = node('div', 'script-icon', 'JS');
  const titleWrap = node('div', 'title-wrap');
  titleWrap.append(node('h3', '', entry.displayName), node('span', 'channel', entry.channel));
  head.append(icon, titleWrap);

  const description = node('p', 'description', entry.description || '暂无说明');
  const versionRow = node('div', 'version-row');
  versionRow.append(
    node('strong', 'version', 'v' + entry.version),
    node('span', 'ready', 'HTTPS 安装包已就绪')
  );

  const metadata = node('div', 'metadata');
  metadata.append(
    node('span', '', '安装包 ' + formatBytes(entry.sizeBytes)),
    node('span', '', 'Namespace: ' + entry.namespace)
  );

  const install = node('a', 'install-button', '安装 / 更新');
  install.href = entry.installUrl;
  install.target = '_blank';
  install.rel = 'noopener';
  install.setAttribute('aria-label', '安装或更新 ' + entry.displayName);

  const endpoints = node('details', 'endpoints');
  endpoints.append(node('summary', '', '查看固定更新地址'));
  const updateLine = node('div', 'endpoint-line');
  updateLine.append(node('small', '', '检查更新'), node('code', '', entry.updateUrl));
  const downloadLine = node('div', 'endpoint-line');
  downloadLine.append(node('small', '', '下载安装'), node('code', '', entry.downloadUrl));
  endpoints.append(updateLine, downloadLine);

  card.append(head, description, versionRow, metadata, install, endpoints);
  if (entry.history && entry.history.length) card.append(createHistory(entry));
  return card;
}

async function loadManifest() {
  refreshButton.disabled = true;
  serverState.classList.remove('offline');
  serverState.replaceChildren(node('i'), document.createTextNode('正在读取公开清单'));
  list.replaceChildren(node('div', 'loading-card', '正在读取公开脚本清单…'));

  try {
    const response = await fetch(endpoint('api/manifest.json'), { cache: 'no-store' });
    if (!response.ok) throw new Error('公开脚本清单暂时不可用（HTTP ' + response.status + '）');
    const manifest = await response.json();

    if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.scripts)) {
      throw new Error('脚本清单格式不正确');
    }

    list.replaceChildren();
    for (const entry of manifest.scripts) list.append(createCard(entry));
    if (!manifest.scripts.length) list.append(node('div', 'loading-card', '清单中暂时没有启用的脚本。'));

    scriptCount.textContent = manifest.scripts.length + ' 个公开脚本';
    buildTime.textContent = '构建于 ' + new Date(manifest.generatedAt).toLocaleString();
    document.getElementById('hub-version').textContent = '安装中心 v' + (manifest.hubVersion || '1.0.0');
    serverState.classList.remove('offline');
    serverState.replaceChildren(node('i'), document.createTextNode('GitHub Pages 正常 · HTTPS 静态托管'));
  } catch (error) {
    list.replaceChildren(node('div', 'error-card', '无法读取公开清单：' + error.message + '。请稍后刷新页面。'));
    serverState.classList.add('offline');
    serverState.replaceChildren(node('i'), document.createTextNode('公开清单暂不可用'));
    scriptCount.textContent = '—';
    buildTime.textContent = '尚无构建信息';
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener('click', loadManifest);
loadManifest();

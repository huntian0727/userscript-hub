'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  buildPages,
  readMetadata,
  withUpdateUrls,
  assertNoEmbeddedSecrets,
  getPublishedAt
} = require('../scripts/build-pages');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'userscript-hub-'));
  for (const dir of ['userscripts', 'public', 'history', 'scripts']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'public', 'index.html'), '<!doctype html><title>Hub</title>');
  fs.writeFileSync(path.join(root, 'public', 'app.js'), 'fetch("./api/manifest.json");');
  fs.writeFileSync(path.join(root, 'public', 'style.css'), 'body { color: black; }');
  fs.writeFileSync(path.join(root, 'public', 'ai-integration.md'), 'Home: {{BASE_URL}} Repo: {{REPOSITORY_URL}} Name: {{REPOSITORY_FULL_NAME}}');
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({
    schemaVersion: 1,
    hubVersion: '1.0.0',
    repository: { owner: 'huntian0727', name: 'userscript-hub', defaultBranch: 'main' },
    scripts: [{
      id: 'sample-script',
      displayName: 'Sample',
      description: 'Safe sample',
      source: 'userscripts/sample.user.js',
      channel: 'Test',
      enabled: true
    }]
  }));
  fs.writeFileSync(path.join(root, 'userscripts', 'sample.user.js'),
    '// ==UserScript==\n// @name Sample\n// @namespace test.sample\n// @version 1.0.0\n// ==/UserScript==\nconsole.log("sample");\n');
  return root;
}

test('readMetadata requires valid userscript metadata', () => {
  const metadata = readMetadata('// ==UserScript==\n// @name A\n// @namespace b\n// @version 1.2.3\n// ==/UserScript==\n');
  assert.equal(metadata.version, '1.2.3');
  assert.throws(() => readMetadata('console.log(1)'), /Missing userscript metadata/);
  assert.throws(() => readMetadata('// ==UserScript==\n// @name A\n// @namespace b\n// @version latest\n// ==/UserScript=='), /Unsupported @version/);
});

test('withUpdateUrls injects stable HTTPS metadata endpoints', () => {
  const source = '// ==UserScript==\n// @name A\n// @namespace b\n// @version 1.0.0\n// @updateURL http://127.0.0.1/old\n// @downloadURL http://127.0.0.1/old\n// ==/UserScript==\n';
  const result = withUpdateUrls(source, 'sample-script', 'https://example.github.io/repo');
  assert.match(result.content, /@updateURL\s+https:\/\/example\.github\.io\/repo\/userscripts\/sample-script\.meta\.js/);
  assert.match(result.content, /@downloadURL\s+https:\/\/example\.github\.io\/repo\/userscripts\/sample-script\.user\.js/);
  assert.doesNotMatch(result.content, /127\.0\.0\.1/);
});

test('public source scanner rejects common embedded credentials', () => {
  assert.doesNotThrow(() => assertNoEmbeddedSecrets('const x = 1;', 'safe'));
  const fakeToken = 'ghp_' + 'a'.repeat(26);
  assert.throws(() => assertNoEmbeddedSecrets('const token = "' + fakeToken + '";', 'bad'), /GitHub token/);
  assert.throws(() => assertNoEmbeddedSecrets('const home = "C:\\Users\\someone\\secret";', 'bad'), /personal Windows path/);
});

test('build emits manifest, integration descriptor, install artifacts and immutable history', () => {
  const root = fixture();
  try {
    const result = buildPages({ rootDir: root, baseUrl: 'https://example.github.io/repo' });
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'site', 'api', 'manifest.json'), 'utf8'));
    const integration = JSON.parse(fs.readFileSync(path.join(root, 'site', 'api', 'integration.json'), 'utf8'));
    assert.equal(manifest.scripts.length, 1);
    assert.equal(manifest.scripts[0].installUrl, 'https://example.github.io/repo/userscripts/sample-script.user.js');
    assert.equal(integration.hosting, 'github-pages');
    assert.equal(integration.capabilities.requiresLocalNodeServer, false);
    assert.ok(fs.existsSync(path.join(root, 'site', 'userscripts', 'sample-script.user.js')));
    assert.ok(fs.existsSync(path.join(root, 'site', 'userscripts', 'sample-script.meta.js')));
    assert.ok(fs.existsSync(path.join(root, 'history', 'sample-script', '1.0.0.user.js')));
    assert.equal(result.manifest.scripts[0].history.length, 1);
    assert.match(fs.readFileSync(path.join(root, 'site', 'ai-integration.md'), 'utf8'), /https:\/\/example\.github\.io\/repo/);
    assert.doesNotThrow(() => buildPages({ rootDir: root, baseUrl: 'https://example.github.io/repo', checkHistory: true }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('build refuses to overwrite a published version with changed content', () => {
  const root = fixture();
  try {
    buildPages({ rootDir: root, baseUrl: 'https://example.github.io/repo' });
    const sourcePath = path.join(root, 'userscripts', 'sample.user.js');
    fs.appendFileSync(sourcePath, 'console.log("changed");\n');
    assert.throws(() => buildPages({ rootDir: root, baseUrl: 'https://example.github.io/repo' }), /History snapshot already exists/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('build rejects sources outside the approved userscripts directory', () => {
  const root = fixture();
  try {
    const registryPath = path.join(root, 'registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    registry.scripts[0].source = '../outside.user.js';
    fs.writeFileSync(registryPath, JSON.stringify(registry));
    assert.throws(() => buildPages({ rootDir: root, baseUrl: 'https://example.github.io/repo' }), /inside userscripts/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('build rejects non-HTTPS Pages base URLs', () => {
  const root = fixture();
  try {
    assert.throws(() => buildPages({ rootDir: root, baseUrl: 'http://example.github.io/repo' }), /HTTPS URL/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('published timestamps come from the exact Git commit for each script version', () => {
  const root = fixture();
  const sourcePath = path.join(root, 'userscripts', 'sample.user.js');
  try {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Userscript Hub Test'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'userscript-hub-test@example.invalid'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['add', 'registry.json', 'userscripts/sample.user.js', 'public'], { cwd: root, stdio: 'ignore' });
    const firstDate = '2026-10-31T17:19:47Z';
    const firstEnv = Object.assign({}, process.env, {
      GIT_AUTHOR_DATE: firstDate,
      GIT_COMMITTER_DATE: firstDate
    });
    execFileSync('git', ['commit', '-m', 'Publish sample source'], {
      cwd: root,
      env: firstEnv,
      stdio: 'ignore'
    });

    const firstBuild = buildPages({ rootDir: root, baseUrl: 'https://example.github.io/repo' });
    assert.equal(firstBuild.manifest.scripts[0].publishedAt, '2026-10-31T17:19:47.000Z');
    assert.equal(firstBuild.manifest.scripts[0].history[0].publishedAt, null);

    execFileSync('git', ['add', 'history/sample-script/1.0.0.user.js'], { cwd: root, stdio: 'ignore' });
    const snapshotDate = '2026-10-31T18:20:30Z';
    const snapshotEnv = Object.assign({}, process.env, {
      GIT_AUTHOR_DATE: snapshotDate,
      GIT_COMMITTER_DATE: snapshotDate
    });
    execFileSync('git', ['commit', '-m', 'Record immutable release snapshot'], {
      cwd: root,
      env: snapshotEnv,
      stdio: 'ignore'
    });

    const secondBuild = buildPages({ rootDir: root, baseUrl: 'https://example.github.io/repo' });
    assert.equal(secondBuild.manifest.scripts[0].publishedAt, '2026-10-31T17:19:47.000Z');
    assert.equal(secondBuild.manifest.scripts[0].history[0].publishedAt, '2026-10-31T18:20:30.000Z');

    fs.appendFileSync(sourcePath, '// local uncommitted edit');
    assert.equal(getPublishedAt(root, sourcePath), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('published homepage uses relative assets and no local server addresses', () => {
  const root = fixture();
  try {
    const htmlPath = path.join(root, 'public', 'index.html');
    fs.writeFileSync(htmlPath, '<link rel="stylesheet" href="./style.css"><script src="./app.js"></script>');
    buildPages({ rootDir: root, baseUrl: 'https://example.github.io/repo' });
    const html = fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8');
    assert.match(html, /href="\.\/style\.css"/);
    assert.match(html, /src="\.\/app\.js"/);
    assert.doesNotMatch(html, /127\.0\.0\.1|localhost/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


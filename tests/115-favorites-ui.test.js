'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'userscripts', '115-multiview-indexed.user.js'),
  'utf8'
);

test('115 multiview v0.10.2 userscript parses and exposes clear favorite controls', () => {
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /^\/\/\s*@version\s+0\.10\.2$/m);
  assert.equal((source.match(/const VERSION = '0\.10\.2';/g) || []).length, 2);
  assert.match(source, /favorite-feedback-toast/);
  assert.match(source, /aria-live', 'polite'/);
  assert.match(source, /id = 'btnFavorites'/);
  assert.match(source, /session\.favoritesButton\.textContent = '★ 收藏 ' \+ favoriteCount/);
  assert.match(source, /点击顶部“★ 收藏”即可查看/);
  assert.match(source, /preferenceStore\.listFavorites\(session\.accountId\)/);
});

test('player has a persistent exit button independent of the auto-hiding toolbar', () => {
  assert.match(source, /session\.exitButton = element\('button', 'player-exit-button', '✕ 退出'\)/);
  assert.match(source, /session\.exitButton\.onclick = event => \{[\s\S]*?closePlayer\(\);[\s\S]*?\};/);
  assert.match(source, /session\.description, session\.favoriteToast, session\.exitButton/);
  assert.match(source, /\.player-exit-button\{position:absolute;top:52px;right:14px;z-index:130/);
  assert.match(source, /退出多画面播放器，返回115网盘/);
});

test('exit cleanup aborts outstanding work and disposes every video cell', () => {
  const closePlayerBody = source.match(/function closePlayer\(\) \{([\s\S]*?)\n  \}\n\n  async function openPlayer/);
  assert.ok(closePlayerBody, 'closePlayer cleanup function exists');
  assert.match(closePlayerBody[1], /session\.abort\.abort\(\)/);
  assert.match(closePlayerBody[1], /session\.cells\.forEach\(cell => \{ if \(cell\) disposeCell\(cell\); \}\)/);
  assert.match(closePlayerBody[1], /session\.panel\.remove\(\)/);
});

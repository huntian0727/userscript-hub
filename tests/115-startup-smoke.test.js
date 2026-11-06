'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const current = fs.readFileSync(path.join(root, 'userscripts/115-multiview-full-disk.user.js'), 'utf8');
const previous = fs.readFileSync(path.join(root, 'history/115-multiview-full-disk/1.6.1.user.js'), 'utf8');

function playerSessionFromRealSource(script, settings = {}) {
  const playerStart = script.lastIndexOf('/* global Hls, GM_xmlhttpRequest */');
  assert.ok(playerStart >= 0, 'player boot boundary exists');
  const player = script.slice(playerStart);
  const headStart = player.indexOf('  const VERSION = ');
  const headEnd = player.indexOf('  const N115IndexStore =', headStart);
  const openStart = player.indexOf('  async function openPlayer(');
  const sessionStart = player.indexOf('      const session = {', openStart);
  const sessionEnd = player.indexOf('\n      const filterPanel =', sessionStart);
  assert.ok(headStart >= 0 && headEnd > headStart && sessionStart > openStart && sessionEnd > sessionStart);
  // Use the actual code between the declaration block and the first UI panel,
  // rather than a hand-written reimplementation of the player initializer.
  const bootDeclarations = player.slice(headStart, headEnd);
  const sessionInitializer = player.slice(sessionStart, sessionEnd);
  const make = new Function(
    'indexed', 'panel', 'grid', 'bar', 'shuffleItems', 'AbortController',
    bootDeclarations + '\nconst items = indexed.items;\n' + sessionInitializer + '\nreturn session;'
  );
  const indexed = {
    source: 'full-disk', items: [{ id: 'synthetic-1' }], accountId: 'synthetic-account',
    scan: { recursive: true }, total: 1, fullDiskSource: { taskId: 'synthetic-task' },
    preferenceState: {}, profiles: [], filters: {}, recentDirectories: [],
    settings: { layoutCount: 4, layoutMode: 'grid', ...settings }
  };
  return make(indexed, {}, {}, {}, items => items.slice(), AbortController);
}

function indexRequestFromRealSource(script) {
  const verifierStart = script.indexOf('(function boot115IndexVerifier()');
  const verifierEnd = script.indexOf('/* N115_FULL_DISK_EXPLORER_BUNDLE_START */', verifierStart);
  assert.ok(verifierStart >= 0 && verifierEnd > verifierStart, 'index manager source boundary exists');
  const verifier = script.slice(verifierStart, verifierEnd);
  const originDeclaration = (verifier.match(/^\s*const API_ORIGIN =[^;]+;/m) || [])[0] || '';
  const start = verifier.indexOf('  function requestText(url, signal) {');
  const end = verifier.indexOf('\n  const adapter =', start);
  assert.ok(start >= 0 && end > start, 'real requestText function exists');
  const requestFunction = verifier.slice(start, end);
  const gmRequest = options => {
    process.nextTick(() => options.onload({
      status: 200, finalUrl: options.url, responseText: '{"synthetic":true}'
    }));
    return { abort() {} };
  };
  return new Function('GM_xmlhttpRequest', originDeclaration + '\n' + requestFunction + '\nreturn requestText;')(gmRequest);
}

test('v1.6.1 failure reproduces; current release initializes the real player session', () => {
  assert.throws(() => playerSessionFromRealSource(previous), /MAX_VIDEOS is not defined/);
  const session = playerSessionFromRealSource(current);
  assert.equal(session.cells.length, 12);
  assert.equal(session.dualSmallCount, 3);
  assert.equal(session.availableItems.length, 1);
  assert.equal(session.layoutCount, 4);
  assert.equal(playerSessionFromRealSource(current, { dualSmallCount: 2 }).dualSmallCount, 2);
});

test('real index-manager request code uses a defined API origin and rejects unexpected origins', async () => {
  const oldRequest = indexRequestFromRealSource(previous);
  await assert.rejects(() => oldRequest('https://webapi.115.com/files?cid=0'), /API_ORIGIN is not defined/);
  const request = indexRequestFromRealSource(current);
  const response = await request('https://webapi.115.com/files?cid=0');
  assert.equal(response.text, '{"synthetic":true}');
  await assert.rejects(
    () => request('https://untrusted.example/files?cid=0'),
    /已阻止非115目录接口请求/
  );
});

test('all restored constants and both independent host IDs exist in the exact release source', () => {
  assert.match(current, /^\/\/ @version\s+1\.8\.1$/m);
  assert.match(current, /const MAX_VIDEOS = 12;/);
  assert.match(current, /const DEFAULT_DUAL_SMALL_COUNT = 3;/);
  assert.match(current, /const API_ORIGIN = 'https:\/\/webapi\.115\.com';/);
  const hosts = [...current.matchAll(/const HOST_ID = '([^']+)';/g)].map(match => match[1]);
  assert.equal(hosts.length, 2);
  assert.equal(new Set(hosts).size, 2);
});

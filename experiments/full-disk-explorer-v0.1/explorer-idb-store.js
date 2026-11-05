'use strict';

const DB_NAME = '115-multiview-explorer';
const DB_VERSION = 1;
const STATE_VERSION = 1;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createExplorerIndexedDbStore(options = {}) {
  const indexedDBRef = options.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
  const keyRangeRef = options.IDBKeyRange || (typeof IDBKeyRange !== 'undefined' ? IDBKeyRange : null);
  const dbName = String(options.dbName || DB_NAME);
  let databasePromise = null;

  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Explorer IndexedDB request failed'));
    });
  }

  function transactionPromise(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('Explorer IndexedDB transaction aborted'));
      transaction.onerror = () => reject(transaction.error || new Error('Explorer IndexedDB transaction failed'));
    });
  }

  function openDatabase() {
    if (!indexedDBRef) return Promise.reject(new Error('IndexedDB is unavailable; full-disk scan cannot be resumed safely'));
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDBRef.open(dbName, DB_VERSION);
      } catch (error) {
        databasePromise = null;
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        let tasks;
        if (db.objectStoreNames.contains('tasks')) {
          tasks = request.transaction.objectStore('tasks');
        } else {
          tasks = db.createObjectStore('tasks', { keyPath: 'taskId' });
        }
        let directories;
        if (db.objectStoreNames.contains('directories')) {
          directories = request.transaction.objectStore('directories');
        } else {
          directories = db.createObjectStore('directories', { keyPath: ['taskId', 'cid'] });
        }
        if (!directories.indexNames.contains('byTask')) {
          directories.createIndex('byTask', 'taskId', { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => {
        databasePromise = null;
        reject(request.error || new Error('Unable to open explorer database'));
      };
      request.onblocked = () => {
        databasePromise = null;
        reject(new Error('Explorer database upgrade is blocked by another open page'));
      };
    });
    return databasePromise;
  }

  function only(value) {
    if (!keyRangeRef) throw new Error('IDBKeyRange is unavailable');
    return keyRangeRef.only(value);
  }

  function taskFromCheckpoint(taskId, checkpoint) {
    if (!checkpoint || checkpoint.version !== STATE_VERSION || checkpoint.currentDirectory) {
      throw new TypeError('createTask requires a fresh scan checkpoint');
    }
    const queueHead = Number(checkpoint.queueHead || 0);
    const root = checkpoint.queue[queueHead];
    if (!root || String(root.cid) !== String(checkpoint.rootCid)) {
      throw new TypeError('fresh checkpoint must contain the root directory at the queue head');
    }
    return {
      taskId,
      accountId: checkpoint.accountId,
      rootCid: checkpoint.rootCid,
      recursive: checkpoint.recursive,
      limits: clone(checkpoint.limits),
      filters: clone(checkpoint.filters || null),
      preferenceSnapshot: clone(checkpoint.preferenceSnapshot || null),
      status: 'running',
      pauseReason: null,
      activeDirectoryCid: null,
      nextSequence: 1,
      directoriesDiscovered: 1,
      directoriesVisited: 0,
      directoriesCompleted: 0,
      depthLimitedDirectories: 0,
      pagesFetched: 0,
      recordsScanned: 0,
      matchedVideos: 0,
      unknownRecords: 0,
      duplicateRecords: 0,
      integrityOk: true,
      truncated: false,
      reservoir: clone(checkpoint.reservoir),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  function copyProgress(task, checkpoint) {
    const fields = [
      'directoriesDiscovered', 'directoriesVisited', 'directoriesCompleted',
      'depthLimitedDirectories', 'pagesFetched', 'recordsScanned', 'matchedVideos',
      'unknownRecords', 'duplicateRecords', 'integrityOk', 'truncated'
    ];
    for (const field of fields) task[field] = checkpoint[field];
    task.reservoir = clone(checkpoint.reservoir);
    task.updatedAt = Date.now();
    return task;
  }

  async function createTask(taskIdValue, checkpoint) {
    const taskId = String(taskIdValue || '').trim();
    if (!taskId) throw new TypeError('taskId is required');
    if (!checkpoint || !String(checkpoint.accountId || '').trim()) throw new TypeError('account-bound checkpoint is required');
    const root = checkpoint.queue[Number(checkpoint.queueHead || 0)];
    const task = taskFromCheckpoint(taskId, checkpoint);
    const rootDirectory = {
      taskId,
      cid: String(root.cid),
      depth: Number(root.depth || 0),
      pathSegments: clone(Array.isArray(root.pathSegments) ? root.pathSegments : []),
      status: 'queued',
      sequence: 0,
      offset: 0,
      totalCount: null,
      pagesFetched: 0,
      recentKeys: [],
      recordsStored: 0,
      filesFound: 0,
      foldersFound: 0,
      videosFound: 0,
      unknownCount: 0,
      duplicateCount: 0
    };
    const db = await openDatabase();
    const tx = db.transaction(['tasks', 'directories'], 'readwrite');
    const done = transactionPromise(tx);
    tx.objectStore('tasks').add(task);
    tx.objectStore('directories').add(rootDirectory);
    await done;
    return taskId;
  }

  async function getTask(taskIdValue) {
    const taskId = String(taskIdValue || '').trim();
    if (!taskId) throw new TypeError('taskId is required');
    const db = await openDatabase();
    const tx = db.transaction('tasks', 'readonly');
    const done = transactionPromise(tx);
    const task = await requestPromise(tx.objectStore('tasks').get(taskId));
    await done;
    return task ? clone(task) : null;
  }

  async function listTasks(accountIdValue) {
    const accountId = String(accountIdValue || '').trim();
    if (!accountId) throw new TypeError('accountId is required');
    const db = await openDatabase();
    const tx = db.transaction('tasks', 'readonly');
    const done = transactionPromise(tx);
    const tasks = await requestPromise(tx.objectStore('tasks').getAll());
    await done;
    return tasks.filter(task => String(task.accountId) === accountId)
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
      .map(clone);
  }

  async function loadTask(taskIdValue) {
    const taskId = String(taskIdValue || '').trim();
    if (!taskId) throw new TypeError('taskId is required');
    const db = await openDatabase();
    const tx = db.transaction(['tasks', 'directories'], 'readonly');
    const done = transactionPromise(tx);
    const taskRequest = tx.objectStore('tasks').get(taskId);
    const directoryRequest = tx.objectStore('directories').index('byTask').getAll(only(taskId));
    const [task, directories] = await Promise.all([
      requestPromise(taskRequest),
      requestPromise(directoryRequest)
    ]);
    await done;
    if (!task) return null;

    directories.sort((left, right) => Number(left.sequence) - Number(right.sequence));
    const discoveredDirectoryIds = {};
    const queue = [];
    let active = null;
    let scanningCount = 0;
    for (const directory of directories) {
      discoveredDirectoryIds[String(directory.cid)] = true;
      if (directory.status === 'queued') {
        queue.push({
          cid: String(directory.cid),
          depth: Number(directory.depth || 0),
          pathSegments: Array.isArray(directory.pathSegments) ? directory.pathSegments : []
        });
      } else if (directory.status === 'scanning') {
        scanningCount += 1;
        if (String(directory.cid) === String(task.activeDirectoryCid)) {
          active = {
            cid: String(directory.cid),
            depth: Number(directory.depth || 0),
            pathSegments: Array.isArray(directory.pathSegments) ? directory.pathSegments : [],
            offset: Number(directory.offset || 0),
            totalCount: directory.totalCount == null ? null : Number(directory.totalCount),
            pagesFetched: Number(directory.pagesFetched || 0),
            recentKeys: Array.isArray(directory.recentKeys) ? directory.recentKeys : [],
            recordsStored: Number(directory.recordsStored || 0),
            filesFound: Number(directory.filesFound || 0),
            foldersFound: Number(directory.foldersFound || 0),
            videosFound: Number(directory.videosFound || 0),
            unknownCount: Number(directory.unknownCount || 0),
            duplicateCount: Number(directory.duplicateCount || 0)
          };
      }
    }
    }
    if ((task.activeDirectoryCid && (!active || scanningCount !== 1)) ||
        (!task.activeDirectoryCid && scanningCount > 0)) {
      throw new Error('Explorer active-directory checkpoint is inconsistent; refusing to resume');
    }
    return {
      taskId,
      version: STATE_VERSION,
      accountId: String(task.accountId),
      rootCid: String(task.rootCid),
      recursive: task.recursive === true,
      limits: clone(task.limits),
      filters: clone(task.filters || null),
      preferenceSnapshot: clone(task.preferenceSnapshot || null),
      status: task.status,
      pauseReason: task.pauseReason || null,
      queue,
      queueHead: 0,
      discoveredDirectoryIds,
      directoriesDiscovered: Number(task.directoriesDiscovered || directories.length),
      currentDirectory: active,
      directoriesVisited: Number(task.directoriesVisited || 0),
      directoriesCompleted: Number(task.directoriesCompleted || 0),
      depthLimitedDirectories: Number(task.depthLimitedDirectories || 0),
      pagesFetched: Number(task.pagesFetched || 0),
      recordsScanned: Number(task.recordsScanned || 0),
      matchedVideos: Number(task.matchedVideos || 0),
      unknownRecords: Number(task.unknownRecords || 0),
      duplicateRecords: Number(task.duplicateRecords || 0),
      integrityOk: task.integrityOk !== false,
      truncated: task.truncated === true,
      reservoir: clone(task.reservoir)
    };
  }

  async function markDirectoryStarted(taskIdValue, checkpoint) {
    const taskId = String(taskIdValue || '').trim();
    const current = checkpoint && checkpoint.currentDirectory;
    if (!taskId || !current) throw new TypeError('an active directory checkpoint is required');
    const cid = String(current.cid);
    const db = await openDatabase();
    const tx = db.transaction(['tasks', 'directories'], 'readwrite');
    const done = transactionPromise(tx);
    const tasks = tx.objectStore('tasks');
    const directories = tx.objectStore('directories');

    const operation = new Promise((resolve, reject) => {
      let task;
      let directory;
      let ready = 0;
      let committed = false;
      const maybeCommit = () => {
        if (ready !== 2 || committed) return;
        committed = true;
        try {
          if (!task || !directory) throw fail('scan task or queued directory is missing', 'N115_TASK_NOT_FOUND');
          if (task.status !== 'running' || task.activeDirectoryCid) {
            throw fail('another directory is already active for this scan task', 'N115_DIRECTORY_ALREADY_ACTIVE');
          }
          if (directory.status !== 'queued') {
            throw fail('directory is no longer queued', 'N115_DIRECTORY_NOT_QUEUED');
          }
          task.activeDirectoryCid = cid;
          task.directoriesVisited = checkpoint.directoriesVisited;
          task.updatedAt = Date.now();
          directory.status = 'scanning';
          tasks.put(task);
          directories.put(directory);
          resolve(true);
        } catch (error) {
          try { tx.abort(); } catch { /* transaction may already be ending */ }
          reject(error);
        }
      };
      const taskRequest = tasks.get(taskId);
      const directoryRequest = directories.get([taskId, cid]);
      taskRequest.onsuccess = () => { task = taskRequest.result; ready += 1; maybeCommit(); };
      directoryRequest.onsuccess = () => { directory = directoryRequest.result; ready += 1; maybeCommit(); };
      taskRequest.onerror = () => reject(taskRequest.error || new Error('Unable to read scan task'));
      directoryRequest.onerror = () => reject(directoryRequest.error || new Error('Unable to read queued directory'));
    });

    try {
      await Promise.all([operation, done]);
      return true;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction may already be ending */ }
      throw error;
    }
  }

  async function commitPage(taskIdValue, page, checkpoint, newFolders = []) {
    const taskId = String(taskIdValue || '').trim();
    const cid = String(page && page.cid || '').trim();
    if (!taskId || !/^\d+$/.test(cid)) throw new TypeError('taskId and numeric page.cid are required');
    if (!checkpoint || checkpoint.version !== STATE_VERSION) throw new TypeError('updated scan checkpoint is required');
    if (!Array.isArray(newFolders)) throw new TypeError('newFolders must be an array');
    const db = await openDatabase();
    const tx = db.transaction(['tasks', 'directories'], 'readwrite');
    const done = transactionPromise(tx);
    const tasks = tx.objectStore('tasks');
    const directories = tx.objectStore('directories');

    const operation = new Promise((resolve, reject) => {
      let task;
      let directory;
      let ready = 0;
      let committed = false;
      const maybeCommit = () => {
        if (ready !== 2 || committed) return;
        committed = true;
        try {
          if (!task || !directory) throw fail('scan task or active directory is missing', 'N115_TASK_NOT_FOUND');
          if (task.status !== 'running' || String(task.activeDirectoryCid) !== cid) {
            throw fail('scan task no longer owns this active directory', 'N115_ACTIVE_DIRECTORY_CHANGED');
          }
          if (directory.status !== 'scanning' || Number(directory.offset || 0) !== Number(page.offset)) {
            throw fail('page offset is stale or already committed', 'N115_PAGE_OFFSET_MISMATCH');
          }
          if (directory.totalCount != null && Number(directory.totalCount) !== Number(page.totalCount)) {
            throw fail('directory total changed during scan', 'N115_DIRECTORY_CHANGED');
          }
          if (Number(page.nextOffset) !== Number(page.offset) + Number(page.rawCount) ||
              Number(page.nextOffset) > Number(page.totalCount)) {
            throw fail('page offset progression is invalid', 'N115_PAGE_RANGE_INVALID');
          }

          const isDirectoryComplete = Number(page.nextOffset) === Number(page.totalCount);
          directory.offset = Number(page.nextOffset);
          directory.totalCount = Number(page.totalCount);
          directory.pagesFetched = Number(directory.pagesFetched || 0) + 1;
          directory.recentKeys = Array.isArray(page.recentKeys) ? page.recentKeys.slice() : [];
          const pageRecords = Array.isArray(page.records) ? page.records : [];
          directory.recordsStored = page.recordsStored === undefined
            ? Number(directory.recordsStored || 0) + pageRecords.length
            : Number(page.recordsStored);
          directory.filesFound = page.filesFound === undefined
            ? Number(directory.filesFound || 0) + pageRecords.filter(record => record.type !== 'folder').length
            : Number(page.filesFound);
          directory.foldersFound = page.foldersFound === undefined
            ? Number(directory.foldersFound || 0) + pageRecords.filter(record => record.type === 'folder').length
            : Number(page.foldersFound);
          directory.videosFound = page.videosFound === undefined
            ? Number(directory.videosFound || 0) + pageRecords.filter(record => record.isVideo || record.type === 'video').length
            : Number(page.videosFound);
          directory.unknownCount = Number(directory.unknownCount || 0) + Number(page.unknownCount || 0);
          directory.duplicateCount = Number(directory.duplicateCount || 0) + Number(page.duplicateCount || 0);
          directory.pathSegments = Array.isArray(page.pathSegments)
            ? clone(page.pathSegments) : directory.pathSegments;
          if (isDirectoryComplete) directory.status = 'complete';

          let sequence = Number(task.nextSequence || 1);
          for (const folder of newFolders) {
            const childCid = String(folder.cid || '').trim();
            if (!/^\d+$/.test(childCid)) throw new TypeError('new folder CID is invalid');
            directories.add({
              taskId,
              cid: childCid,
              depth: Number(folder.depth || 0),
              pathSegments: clone(Array.isArray(folder.pathSegments) ? folder.pathSegments : []),
              status: 'queued',
              sequence: sequence++,
              offset: 0,
              totalCount: null,
              pagesFetched: 0,
              recentKeys: [],
              recordsStored: 0,
              filesFound: 0,
              foldersFound: 0,
              videosFound: 0,
              unknownCount: 0,
              duplicateCount: 0
            });
          }
          task.nextSequence = sequence;
          copyProgress(task, checkpoint);
          if (isDirectoryComplete) task.activeDirectoryCid = null;
          tasks.put(task);
          directories.put(directory);
          resolve({ directoryComplete: isDirectoryComplete, nextSequence: sequence });
        } catch (error) {
          try { tx.abort(); } catch { /* transaction may already be ending */ }
          reject(error);
        }
      };
      const taskRequest = tasks.get(taskId);
      const directoryRequest = directories.get([taskId, cid]);
      taskRequest.onsuccess = () => { task = taskRequest.result; ready += 1; maybeCommit(); };
      directoryRequest.onsuccess = () => { directory = directoryRequest.result; ready += 1; maybeCommit(); };
      taskRequest.onerror = () => reject(taskRequest.error || new Error('Unable to read scan task'));
      directoryRequest.onerror = () => reject(directoryRequest.error || new Error('Unable to read active directory'));
    });

    try {
      const [result] = await Promise.all([operation, done]);
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction may already be ending */ }
      throw error;
    }
  }

  async function invalidateTask(taskIdValue, errorValue) {
    const taskId = String(taskIdValue || '').trim();
    if (!taskId) throw new TypeError('taskId is required');
    const message = String(errorValue && errorValue.message || errorValue || 'scan invalidated').slice(0, 240);
    const db = await openDatabase();
    const tx = db.transaction(['tasks', 'directories'], 'readwrite');
    const done = transactionPromise(tx);
    const tasks = tx.objectStore('tasks');
    const directories = tx.objectStore('directories');

    const operation = new Promise((resolve, reject) => {
      const taskRequest = tasks.get(taskId);
      taskRequest.onsuccess = () => {
        try {
          const task = taskRequest.result;
          if (!task) throw fail('scan task not found', 'N115_TASK_NOT_FOUND');
          const finish = directory => {
            if (directory) {
              directory.status = 'invalid';
              directories.put(directory);
            }
            task.activeDirectoryCid = null;
            task.status = 'incomplete';
            task.lastError = message;
            task.pauseReason = '扫描数据一致性无法确认，请重新开始全盘扫描';
            task.updatedAt = Date.now();
            tasks.put(task);
            resolve(true);
          };
          if (task.activeDirectoryCid) {
            const directoryRequest = directories.get([taskId, String(task.activeDirectoryCid)]);
            directoryRequest.onsuccess = () => finish(directoryRequest.result);
            directoryRequest.onerror = () => reject(directoryRequest.error || new Error('Unable to invalidate active directory'));
          } else {
            finish(null);
          }
        } catch (error) {
          try { tx.abort(); } catch { /* transaction may already be ending */ }
          reject(error);
        }
      };
      taskRequest.onerror = () => reject(taskRequest.error || new Error('Unable to read scan task'));
    });

    await Promise.all([operation, done]);
    return true;
  }

  async function pauseTask(taskIdValue, checkpoint, reason = 'paused') {
    const taskId = String(taskIdValue || '').trim();
    if (!taskId || !checkpoint) throw new TypeError('taskId and checkpoint are required');
    const db = await openDatabase();
    const tx = db.transaction('tasks', 'readwrite');
    const done = transactionPromise(tx);
    const tasks = tx.objectStore('tasks');
    const operation = new Promise((resolve, reject) => {
      const request = tasks.get(taskId);
      request.onsuccess = () => {
        try {
          const task = request.result;
          if (!task) throw fail('scan task not found', 'N115_TASK_NOT_FOUND');
          copyProgress(task, checkpoint);
          task.status = 'paused';
          task.pauseReason = String(reason).slice(0, 240);
          tasks.put(task);
          resolve(true);
        } catch (error) {
          try { tx.abort(); } catch { /* transaction may already be ending */ }
          reject(error);
        }
      };
      request.onerror = () => reject(request.error || new Error('Unable to pause scan task'));
    });
    await Promise.all([operation, done]);
    return true;
  }

  async function recoverInterruptedTask(taskIdValue, accountIdValue, staleAfterMs = 30000) {
    const taskId = String(taskIdValue || '').trim();
    const owner = String(accountIdValue || '').trim();
    const staleAfter = Number.isSafeInteger(staleAfterMs) && staleAfterMs >= 0 ? staleAfterMs : 30000;
    if (!taskId || !owner) throw new TypeError('taskId and accountId are required');
    const db = await openDatabase();
    const tx = db.transaction('tasks', 'readwrite');
    const done = transactionPromise(tx);
    const tasks = tx.objectStore('tasks');
    const operation = new Promise((resolve, reject) => {
      const request = tasks.get(taskId);
      request.onsuccess = () => {
        try {
          const task = request.result;
          if (!task) throw fail('scan task not found', 'N115_TASK_NOT_FOUND');
          if (String(task.accountId) !== owner) {
            throw fail('115 account changed; refusing to recover another account scan', 'N115_ACCOUNT_CHANGED');
          }
          if (task.status === 'paused') { resolve(true); return; }
          if (task.status !== 'running' || Date.now() - Number(task.updatedAt || 0) < staleAfter) {
            resolve(false);
            return;
          }
          task.status = 'paused';
          task.pauseReason = '检测到上次页面已中断，已恢复到最近一次成功保存的分页';
          task.updatedAt = Date.now();
          tasks.put(task);
          resolve(true);
        } catch (error) {
          try { tx.abort(); } catch { /* transaction may already be ending */ }
          reject(error);
        }
      };
      request.onerror = () => reject(request.error || new Error('Unable to recover interrupted scan task'));
    });
    const [recovered] = await Promise.all([operation, done]);
    return recovered;
  }

  async function resumeTask(taskIdValue, accountId) {
    const taskId = String(taskIdValue || '').trim();
    const owner = String(accountId || '').trim();
    if (!taskId || !owner) throw new TypeError('taskId and accountId are required');
    const db = await openDatabase();
    const tx = db.transaction('tasks', 'readwrite');
    const done = transactionPromise(tx);
    const tasks = tx.objectStore('tasks');
    const operation = new Promise((resolve, reject) => {
      const request = tasks.get(taskId);
      request.onsuccess = () => {
        try {
          const task = request.result;
          if (!task) throw fail('scan task not found', 'N115_TASK_NOT_FOUND');
          if (String(task.accountId) !== owner) {
            throw fail('115 account changed; refusing to mix scan data across accounts', 'N115_ACCOUNT_CHANGED');
          }
          if (task.status !== 'paused') throw new Error('only a paused scan task can be resumed');
          task.status = 'running';
          task.pauseReason = null;
          task.updatedAt = Date.now();
          tasks.put(task);
          resolve(true);
        } catch (error) {
          try { tx.abort(); } catch { /* transaction may already be ending */ }
          reject(error);
        }
      };
      request.onerror = () => reject(request.error || new Error('Unable to resume scan task'));
    });
    await Promise.all([operation, done]);
    return loadTask(taskId);
  }

  async function finalizeTask(taskIdValue, checkpoint) {
    const taskId = String(taskIdValue || '').trim();
    if (!taskId || !checkpoint) throw new TypeError('taskId and checkpoint are required');
    if (checkpoint.currentDirectory || Number(checkpoint.queueHead || 0) < checkpoint.queue.length) {
      throw new Error('cannot finalize a scan while directories remain');
    }
    const db = await openDatabase();
    const tx = db.transaction('tasks', 'readwrite');
    const done = transactionPromise(tx);
    const tasks = tx.objectStore('tasks');
    const operation = new Promise((resolve, reject) => {
      const request = tasks.get(taskId);
      request.onsuccess = () => {
        try {
          const task = request.result;
          if (!task) throw fail('scan task not found', 'N115_TASK_NOT_FOUND');
          if (task.activeDirectoryCid) throw new Error('cannot finalize while a directory is active');
          copyProgress(task, checkpoint);
          task.status = checkpoint.truncated || !checkpoint.integrityOk ? 'incomplete' : 'complete';
          task.pauseReason = null;
          tasks.put(task);
          resolve(task.status);
        } catch (error) {
          try { tx.abort(); } catch { /* transaction may already be ending */ }
          reject(error);
        }
      };
      request.onerror = () => reject(request.error || new Error('Unable to finalize scan task'));
    });
    const [status] = await Promise.all([operation, done]);
    return status;
  }

  function close() {
    if (!databasePromise) return;
    void databasePromise.then(database => database.close()).catch(() => {});
    databasePromise = null;
  }

  return Object.freeze({
    close,
    commitPage,
    createTask,
    finalizeTask,
    getTask,
    invalidateTask,
    listTasks,
    loadTask,
    markDirectoryStarted,
    pauseTask,
    resumeTask,
    recoverInterruptedTask
  });}

module.exports = Object.freeze({
  DB_NAME,
  DB_VERSION,
  createExplorerIndexedDbStore
});

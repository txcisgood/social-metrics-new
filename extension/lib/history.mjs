import {collectionPlatform} from './format.mjs';
import {summarize} from './workbook.mjs';

export const HISTORY_LIMIT = 5;
const DATABASE = 'social-metrics-result-history';
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const newestFirst = (a, b) => b.completedAt.localeCompare(a.completedAt) || b.id.localeCompare(a.id);

export function historyRecord(run, module = 'accounts', now = new Date()) {
  if (typeof run.id !== 'string' || !run.id || !Array.isArray(run.results) || !run.results.length) throw new Error('历史结果格式无效');
  // Deliberately omit options, diagnostics, credentials and uploaded files.
  const meta = structuredClone(run.meta || {}), results = structuredClone(run.results);
  const summary = summarize(results);
  return {schemaVersion: 1, id: run.id, module: module === 'youtube' ? 'youtube' : 'accounts', meta, results,
    platform: collectionPlatform(results, meta),
    completedAt: validTime(meta['结束时间']) ? new Date(meta['结束时间']).toISOString() : now.toISOString(),
    status: ['completed', 'review', 'stopped', 'interrupted'].includes(run.status) ? run.status : summary.failedAccounts ? 'review' : 'completed',
    targetCount: Number(meta['账号数']) || new Set(results.map(row => JSON.stringify([row.platform, row.row_no]))).size,
    postCount: summary.posts, reviewCount: summary.failedAccounts,
    commentCount: results.reduce((total, row) => total + (row.comments?.length || 0), 0),
    mode: meta['采集模式'] || '账号主页采集', filter: meta['搜索筛选'] || '', source: meta['搜索关键词'] || meta.inputName || ''};
}

export function createHistoryStore({module = 'accounts', indexedDB = globalThis.indexedDB} = {}) {
  module = module === 'youtube' ? 'youtube' : 'accounts';
  let connection;
  function database() {
    if (!indexedDB) return Promise.reject(new Error('历史记录存储不可用'));
    connection ||= new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('runs', {keyPath: ['module', 'id']});
        db.createObjectStore('summaries', {keyPath: ['module', 'id']}).createIndex('module', 'module');
      };
      request.onerror = () => { connection = undefined; reject(request.error); };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); connection = undefined; };
        resolve(db);
      };
    });
    return connection;
  }
  async function transaction(stores, mode, action) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result, failure;
      const abort = error => { failure = error; tx.abort(); };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || tx.error || new Error('历史记录保存未完成'));
      try { action(tx, value => { result = value; }, abort); } catch (error) { abort(error); }
    });
  }
  return {
    list() {
      return transaction(['summaries'], 'readonly', (tx, done) => {
        const request = tx.objectStore('summaries').index('module').getAll(module);
        request.onsuccess = () => done(request.result.filter(row => !row.deleted).sort(newestFirst).slice(0, HISTORY_LIMIT));
      });
    },
    read(id) {
      return transaction(['runs'], 'readonly', (tx, done) => {
        const request = tx.objectStore('runs').get([module, id]);
        request.onsuccess = () => done(request.result);
      });
    },
    save(run) {
      const record = historyRecord(run, module);
      return transaction(['runs', 'summaries'], 'readwrite', (tx, done, abort) => {
        const summaries = tx.objectStore('summaries'), runs = tx.objectStore('runs');
        const request = summaries.index('module').getAll(module);
        request.onsuccess = () => {
          try {
            const previous = request.result.find(row => row.id === record.id);
            // A restored session must not resurrect a user-deleted history.
            if (previous?.deleted) { done(undefined); return; }
            if (previous && !validTime(record.meta['结束时间'])) record.completedAt = previous.completedAt;
            const {results, meta, ...summary} = record;
            runs.put(record); summaries.put(summary);
            const ordered = [...request.result.filter(row => !row.deleted && row.id !== record.id), summary].sort(newestFirst);
            for (const old of ordered.slice(HISTORY_LIMIT)) {
              runs.delete([module, old.id]); summaries.delete([module, old.id]);
            }
            done(summary);
          } catch (error) { abort(error); }
        };
      });
    },
    remove(id) {
      return transaction(['runs', 'summaries'], 'readwrite', (tx, done, abort) => {
        const summaries = tx.objectStore('summaries');
        const request = summaries.index('module').getAll(module);
        request.onsuccess = () => {
          try {
            const tombstone = {id, module, deleted: true, completedAt: new Date().toISOString()};
            tx.objectStore('runs').delete([module, id]); summaries.put(tombstone);
            // Only a few bytes per deleted ID; never keep deleted payloads.
            const deleted = [...request.result.filter(row => row.deleted && row.id !== id), tombstone].sort(newestFirst);
            for (const old of deleted.slice(50)) summaries.delete([module, old.id]);
          } catch (error) { abort(error); }
        };
      });
    },
  };
}

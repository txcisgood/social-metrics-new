import {createDiagnostics} from './diagnostics.mjs';

const RUN_ID = /^SM-\d{14}-[a-f0-9]{12}$/;
const MAX_CLEARED_IDS = 256;

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function clearingBoundary(value) {
  // The first release stored only a timestamp. Without IDs, equality cannot
  // distinguish an old run from a new one, so keep that boundary inclusive.
  if (typeof value === 'string') {
    const at = timestamp(value);
    return at ? {at, runIds: [], inclusive: true} : null;
  }
  const at = timestamp(value?.at);
  if (!at) return null;
  const ids = Array.isArray(value.runIds) ? [...new Set(value.runIds.filter(id => typeof id === 'string' && RUN_ID.test(id)))] : [];
  return {at, runIds: ids.slice(-MAX_CLEARED_IDS),
    inclusive: value.inclusive === true || value.schemaVersion !== 2 || !Array.isArray(value.runIds) || ids.length > MAX_CLEARED_IDS};
}

function wasCleared(snapshot, boundary) {
  return Boolean(boundary && (boundary.runIds.includes(snapshot.id) || snapshot.createdAt < boundary.at ||
    (boundary.inclusive && snapshot.createdAt === boundary.at)));
}

function validatedSnapshot(value) {
  try {
    const validator = createDiagnostics();
    if (!validator.restore(value)) return null;
    const clean = validator.snapshot();
    // A valid empty initial run is useful; an entirely corrupt entry list is not.
    return value.entries.length && !clean.entries.length ? null : clean;
  } catch { return null; }
}

export function createDiagnosticStore({module = 'accounts'} = {}) {
  const PREFIX = module === 'youtube' ? 'metrics.youtubeDiagnostics.' : 'metrics.diagnostics.';
  const CLEARED_AT = module === 'youtube' ? 'metrics.youtubeDiagnosticsClearedAt' : 'metrics.diagnosticsClearedAt';
  const BOOT_ERROR = module === 'youtube' ? 'metrics.youtubeBootError' : 'metrics.bootError';
  function savedRuns(all, boundary = clearingBoundary(all[CLEARED_AT])) {
    const runs = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(PREFIX)) continue;
      const clean = validatedSnapshot(value);
      if (!clean || key !== PREFIX + clean.id || wasCleared(clean, boundary)) continue;
      runs.push({key, snapshot: {...clean, savedAt: timestamp(value.savedAt) || clean.createdAt}});
    }
    return runs.sort((a, b) => b.snapshot.savedAt.localeCompare(a.snapshot.savedAt));
  }

  // Independent keys prevent a second worktab from replacing an active run's log.
  // Writes are serialized, and only three bounded snapshots are retained locally.
  async function persistDiagnostics(snapshot) {
    if (!globalThis.chrome?.storage?.local) return;
    const write = async () => {
      const store = chrome.storage.local;
      const all = await store.get(null);
      // Idle worktabs may still hold an older in-memory log after the user clears
      // history elsewhere. A tombstone prevents those old logs from reappearing.
      const incoming = validatedSnapshot(snapshot);
      if (!incoming || wasCleared(incoming, clearingBoundary(all[CLEARED_AT]))) return;
      const previous = validatedSnapshot(all[PREFIX + incoming.id]);
      const entries = new Map((previous?.entries || []).map(entry => [entry.id, entry]));
      for (const entry of incoming.entries) entries.set(entry.id, entry);
      const clean = validatedSnapshot({...incoming,
        entries: [...entries.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)),
        dropped: Math.max(previous?.dropped || 0, incoming.dropped || 0)});
      if (!clean) return;
      const merged = {...clean, savedAt: new Date().toISOString()};
      const key = PREFIX + incoming.id;
      await store.set({[key]: merged});
      all[key] = merged;
      const keep = new Set(savedRuns(all).slice(0, 3).map(run => run.key));
      const remove = Object.keys(all).filter(k => k.startsWith(PREFIX) && !keep.has(k));
      if (remove.length) await store.remove(remove);
    };
    if (globalThis.navigator?.locks) await navigator.locks.request('social-metrics-log-storage', write);
    else await write();
  }

  async function latestDiagnostics(runId) {
    if (!globalThis.chrome?.storage?.local) return null;
    if (runId !== undefined && (typeof runId !== 'string' || !RUN_ID.test(runId))) return null;
    const all = await chrome.storage.local.get(null);
    const runs = savedRuns(all);
    return (runId === undefined ? runs[0] : runs.find(run => run.snapshot.id === runId))?.snapshot || null;
  }

  async function clearStoredDiagnostics() {
    if (!globalThis.chrome?.storage?.local) return;
    const clear = async () => {
      const all = await chrome.storage.local.get(null);
      const previous = clearingBoundary(all[CLEARED_AT]);
      // Never move a clearing boundary backwards if the system clock changes.
      const at = [new Date().toISOString(), previous?.at || ''].sort().at(-1);
      const runIds = [...new Set([...(previous?.runIds || []),
        ...Object.keys(all).filter(key => key.startsWith(PREFIX)).map(key => key.slice(PREFIX.length)).filter(id => RUN_ID.test(id))])];
      await chrome.storage.local.set({[CLEARED_AT]: {schemaVersion: 2, at, runIds: runIds.slice(-MAX_CLEARED_IDS),
        // A bounded ID list must not re-enable omitted IDs at the exact boundary.
        // Older IDs remain blocked by time; at overflow, equality is conservative.
        inclusive: Boolean(previous?.inclusive && previous.at === at) || runIds.length > MAX_CLEARED_IDS}});
      await chrome.storage.local.remove([...Object.keys(all).filter(k => k.startsWith(PREFIX)), BOOT_ERROR]);
    };
    if (globalThis.navigator?.locks) await navigator.locks.request('social-metrics-log-storage', clear);
    else await clear();
  }
  return {persistDiagnostics, latestDiagnostics, clearStoredDiagnostics};
}

export const {persistDiagnostics, latestDiagnostics, clearStoredDiagnostics} = createDiagnosticStore();

import {APPEARANCE_CHOICES} from './appearance.mjs';
import {KEYWORD_FILTERS} from './youtube-search.mjs';

export const PREFERENCES_KEY = 'metrics.preferences.v1';

const choices = {
  platformSelect: ['instagram', 'youtube', 'all'],
  dateMode: ['days', 'date', 'month', 'quarter', 'range'],
  timeZone: ['Europe/London', 'Asia/Shanghai', 'America/Los_Angeles', 'UTC'],
  scanMode: ['recent', 'complete'],
  youtubeMode: ['channel', 'videos', 'keyword'], videoInputSource: ['text', 'file'], youtubeRange: ['dates', 'all'],
  youtubeSearchFilter: Object.keys(KEYWORD_FILTERS),
  ...APPEARANCE_CHOICES,
};
const numbers = {days: [1, 366], quarterYear: [1, 9999], quarter: [1, 4], maxPages: [1, 50],
  maxPosts: [1, 500], minDelay: [3, 120], maxDelay: [3, 120], youtubeLimit: [1, 100]};
const dates = ['targetDate', 'startDate', 'endDate'];
const booleans = ['showCommentDetails'];
export const PREFERENCE_FIELDS = [...Object.keys(choices), ...Object.keys(numbers), ...dates, 'targetMonth', ...booleans];

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

export function sanitizeSettings(value) {
  const clean = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return clean;
  for (const [field, options] of Object.entries(choices)) if (options.includes(value[field])) clean[field] = value[field];
  for (const field of booleans) if (typeof value[field] === 'boolean') clean[field] = value[field];
  for (const [field, [min, max]] of Object.entries(numbers)) {
    const number = value[field];
    if (typeof number === 'number' && Number.isFinite(number) && number >= min && number <= max &&
        (field.endsWith('Delay') || Number.isInteger(number))) clean[field] = number;
  }
  for (const field of dates) if (validDate(value[field])) clean[field] = value[field];
  if (typeof value.targetMonth === 'string' && /^\d{4}-\d{2}$/.test(value.targetMonth) && validDate(`${value.targetMonth}-01`)) {
    clean.targetMonth = value.targetMonth;
  }
  if (clean.minDelay > clean.maxDelay) { delete clean.minDelay; delete clean.maxDelay; }
  if (clean.startDate && clean.endDate) {
    const days = (Date.parse(`${clean.endDate}T00:00:00Z`) - Date.parse(`${clean.startDate}T00:00:00Z`)) / 86400000 + 1;
    if (days < 1 || days > 366) { delete clean.startDate; delete clean.endDate; }
  }
  return clean;
}

function cleanKey(value) {
  return typeof value === 'string' && value.trim().length <= 512 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : '';
}

function normalize(value) {
  if (!value || value.schemaVersion !== 1 || Array.isArray(value)) return null;
  const rememberYoutubeKey = value.rememberYoutubeKey === undefined || value.rememberYoutubeKey === true;
  const key = rememberYoutubeKey ? cleanKey(value.youtubeKey) : '';
  return {schemaVersion: 1, settings: sanitizeSettings(value.settings),
    ...(Object.hasOwn(value, 'youtubeSettings') ? {youtubeSettings: sanitizeSettings(value.youtubeSettings)} : {}),
    rememberYoutubeKey, ...(key ? {youtubeKey: key} : {})};
}

// Only allowlisted configuration lives here. File contents, tab IDs, results and
// diagnostics remain in their own stores. Field patches merge under a shared
// lock so an idle worktab cannot overwrite newer settings or resurrect a key.
export function createPreferencesStore({storage = globalThis.chrome?.storage?.local, locks = globalThis.navigator?.locks, module = 'accounts'} = {}) {
  let writes = Promise.resolve(), protection;
  const settingsField = module === 'youtube' ? 'youtubeSettings' : 'settings';
  function view(value) {
    if (!value) return null;
    const {youtubeSettings, ...saved} = value;
    return {...saved, settings: settingsField === 'youtubeSettings' ? youtubeSettings || {} : saved.settings};
  }
  async function protect() {
    if (!storage) throw new Error('PREFERENCES_STORAGE_UNAVAILABLE');
    protection ||= Promise.resolve().then(() => storage.setAccessLevel?.({accessLevel: 'TRUSTED_CONTEXTS'}))
      .catch(error => { protection = undefined; throw error; });
    await protection;
  }
  async function load() {
    await protect();
    await writes;
    return view(normalize((await storage.get(PREFERENCES_KEY))[PREFERENCES_KEY]));
  }
  function update(patch = {}) {
    // Copy immediately; caller edits must not change an already queued write.
    const settings = sanitizeSettings(patch.settings);
    if (module === 'youtube') delete settings.platformSelect;
    const remember = typeof patch.rememberYoutubeKey === 'boolean' ? patch.rememberYoutubeKey : undefined;
    const hasKey = Object.hasOwn(patch, 'youtubeKey'), key = cleanKey(patch.youtubeKey);
    const write = async () => {
      await protect();
      const current = normalize((await storage.get(PREFERENCES_KEY))[PREFERENCES_KEY]) ||
        {schemaVersion: 1, settings: {}, rememberYoutubeKey: true};
      current[settingsField] = sanitizeSettings({...current[settingsField], ...settings});
      if (remember !== undefined) current.rememberYoutubeKey = remember;
      if (!current.rememberYoutubeKey || (hasKey && !key)) delete current.youtubeKey;
      else if (hasKey) current.youtubeKey = key;
      await storage.set({[PREFERENCES_KEY]: current});
      return view(current);
    };
    const pending = writes.then(() => locks ? locks.request('social-metrics-preferences', write) : write());
    writes = pending.catch(() => {});
    return pending;
  }
  return {load, update, flush: () => writes};
}

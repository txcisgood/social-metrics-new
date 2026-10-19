import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppearanceController, resolveAppearance} from '../extension/lib/appearance.mjs';

function environment(systemDark = false) {
  const root = {dataset: {}}, listeners = new Set();
  const themeColor = {setAttribute(name, value) { this[name] = value; }};
  const colorScheme = {setAttribute(name, value) { this[name] = value; }};
  const mediaQuery = {
    matches: systemDark,
    addEventListener(name, callback) { assert.equal(name, 'change'); listeners.add(callback); },
    removeEventListener(name, callback) { assert.equal(name, 'change'); listeners.delete(callback); },
  };
  const controller = createAppearanceController({root, themeColor, colorScheme, mediaQuery});
  return {root, themeColor, colorScheme, controller, listeners,
    systemChanged(dark) { mediaQuery.matches = dark; for (const listener of listeners) listener({matches: dark}); }};
}

test('missing or invalid legacy appearance settings preserve the previous dark tech style', () => {
  for (const settings of [undefined, null, {}, {themeMode: 'auto', interfaceStyle: 'unknown'}]) {
    assert.deepEqual(resolveAppearance(settings), {themeMode: 'dark', interfaceStyle: 'tech', theme: 'dark'});
  }
  const env = environment(false);
  assert.deepEqual(env.root.dataset, {theme: 'dark', themeMode: 'dark', style: 'tech'});
  assert.equal(env.themeColor.content, '#0d1424');
  assert.equal(env.colorScheme.content, 'dark');
});

test('both styles support explicit light and dark independently of the operating system', () => {
  const env = environment();
  for (const interfaceStyle of ['tech', 'classic']) for (const themeMode of ['dark', 'light']) {
    env.controller.update({interfaceStyle, themeMode});
    env.systemChanged(themeMode !== 'dark');
    assert.deepEqual(env.root.dataset, {theme: themeMode, themeMode, style: interfaceStyle});
    assert.equal(env.colorScheme.content, themeMode);
  }
});

test('system mode responds to both system changes while preserving the chosen interface style', () => {
  const env = environment(false);
  env.controller.update({themeMode: 'system', interfaceStyle: 'classic'});
  assert.deepEqual(env.root.dataset, {theme: 'light', themeMode: 'system', style: 'classic'});
  assert.equal(env.themeColor.content, '#f5f6fa');
  env.systemChanged(true);
  assert.deepEqual(env.root.dataset, {theme: 'dark', themeMode: 'system', style: 'classic'});
  assert.equal(env.themeColor.content, '#161b26');
  assert.equal(env.colorScheme.content, 'dark');
  env.systemChanged(false);
  assert.equal(env.root.dataset.theme, 'light');
});

test('switching out of system mode ignores later system changes and entering it reads the latest value', () => {
  const env = environment(true);
  env.controller.update({themeMode: 'system'});
  env.controller.update({themeMode: 'light'});
  env.systemChanged(false);
  env.systemChanged(true);
  assert.equal(env.root.dataset.theme, 'light');
  env.controller.update({themeMode: 'system'});
  assert.equal(env.root.dataset.theme, 'dark');
});

test('appearance patches preserve independent choices and ignore unrelated or invalid data', () => {
  const env = environment(false);
  env.controller.update({themeMode: 'system', interfaceStyle: 'classic'});
  const patch = {interfaceStyle: 'tech', themeMode: 'invalid', youtubeKey: 'NEVER_COPY', results: ['untouched']};
  env.controller.update(patch);
  assert.deepEqual(env.root.dataset, {theme: 'light', themeMode: 'system', style: 'tech'});
  assert.equal(env.themeColor.content, '#f3f6fc');
  assert.deepEqual(patch.results, ['untouched']);
  assert.equal(JSON.stringify(env.root).includes('NEVER_COPY'), false);
});

test('controller releases its system observer and works when matchMedia is unavailable', () => {
  const env = environment(false);
  env.controller.update({themeMode: 'system'});
  env.controller.dispose();
  assert.equal(env.listeners.size, 0);
  env.systemChanged(true);
  assert.equal(env.root.dataset.theme, 'light');
  const root = {dataset: {}};
  createAppearanceController({root, themeColor: null, colorScheme: null, mediaQuery: null}).update({themeMode: 'system'});
  assert.equal(root.dataset.theme, 'light');
});

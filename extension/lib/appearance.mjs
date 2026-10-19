export const APPEARANCE_CHOICES = {
  themeMode: ['dark', 'light', 'system'],
  interfaceStyle: ['tech', 'classic'],
};
export const DEFAULT_APPEARANCE = {themeMode: 'dark', interfaceStyle: 'tech'};

export function resolveAppearance(settings = {}, systemDark = false) {
  const themeMode = APPEARANCE_CHOICES.themeMode.includes(settings?.themeMode) ? settings.themeMode : DEFAULT_APPEARANCE.themeMode;
  const interfaceStyle = APPEARANCE_CHOICES.interfaceStyle.includes(settings?.interfaceStyle) ? settings.interfaceStyle : DEFAULT_APPEARANCE.interfaceStyle;
  return {themeMode, interfaceStyle, theme: themeMode === 'system' ? (systemDark ? 'dark' : 'light') : themeMode};
}

// Appearance is deliberately independent of collection options, results and
// credentials. System changes only affect the page when the user chose system.
export function createAppearanceController({
  root = globalThis.document?.documentElement,
  themeColor = globalThis.document?.querySelector('meta[name="theme-color"]'),
  colorScheme = globalThis.document?.querySelector('meta[name="color-scheme"]'),
  mediaQuery = globalThis.matchMedia?.('(prefers-color-scheme: dark)'),
} = {}) {
  let settings = {...DEFAULT_APPEARANCE};
  const colors = {tech: {dark: '#0d1424', light: '#f3f6fc'}, classic: {dark: '#161b26', light: '#f5f6fa'}};
  function render() {
    const appearance = resolveAppearance(settings, Boolean(mediaQuery?.matches));
    if (root) {
      root.dataset.theme = appearance.theme;
      root.dataset.themeMode = appearance.themeMode;
      root.dataset.style = appearance.interfaceStyle;
    }
    themeColor?.setAttribute('content', colors[appearance.interfaceStyle][appearance.theme]);
    colorScheme?.setAttribute('content', appearance.theme);
    return appearance;
  }
  function update(patch = {}) {
    for (const [field, options] of Object.entries(APPEARANCE_CHOICES)) {
      if (options.includes(patch[field])) settings[field] = patch[field];
    }
    return render();
  }
  function systemChanged() { if (settings.themeMode === 'system') render(); }
  mediaQuery?.addEventListener('change', systemChanged);
  render();
  return {update, dispose: () => mediaQuery?.removeEventListener('change', systemChanged)};
}

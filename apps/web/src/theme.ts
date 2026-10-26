export type Theme = 'sage' | 'blue';
const storageKey = 'chaos.theme.v1';
export function readTheme(): Theme {
  try {
    return localStorage.getItem(storageKey) === 'blue' ? 'blue' : 'sage';
  } catch {
    return 'sage';
  }
}
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute(
      'content',
      getComputedStyle(document.documentElement).getPropertyValue('--paper').trim(),
    );
}
export function saveTheme(theme: Theme) {
  applyTheme(theme);
  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    /* Restricted browsers still allow changing the theme for this session. */
  }
}

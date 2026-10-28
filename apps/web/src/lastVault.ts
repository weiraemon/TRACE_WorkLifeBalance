const key = 'chaos.lastVault.v1';
export function readLastVault(): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
export function rememberVault(root: string) {
  try {
    localStorage.setItem(key, root);
  } catch {
    /* Storage may be disabled. */
  }
}

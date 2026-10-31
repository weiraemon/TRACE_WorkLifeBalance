export function externalLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    // Preserve the optional Obsidian "open note" action, without arbitrary protocol handlers.
    if (
      url.protocol === 'obsidian:' &&
      url.hostname === 'open' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.searchParams.get('path') &&
      [...url.searchParams.keys()].join() === 'path'
    )
      return url.href;
  } catch {
    /* Invalid resource links stay inside the app. */
  }
}

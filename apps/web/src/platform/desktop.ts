export function desktopBridge() {
  return window.chaosDesktop;
}

declare global {
  interface Window {
    chaosDesktop?: {
      chooseDirectory: () => Promise<string | null>;
      setupQq: (input: { dataDir: string; selfQQ: string }) => Promise<void>;
    };
  }
}

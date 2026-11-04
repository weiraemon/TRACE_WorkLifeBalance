export function desktopBridge() {
  return window.chaosDesktop;
}

declare global {
  interface Window {
    chaosDesktop?: {
      discoverQq: (input: {
        seed?: string;
        browse?: boolean;
      }) => Promise<{
        accounts: { dataDir: string; selfQQ: string; modified: string }[];
        limited: boolean;
      } | null>;
      chooseDirectory: () => Promise<string | null>;
      setupQq: (input: { dataDir: string; selfQQ: string }) => Promise<void>;
    };
  }
}

export {};
declare global {
  interface Window {
    chaosDesktop?: {
      chooseDirectory: () => Promise<string | null>;
      setupQq: () => Promise<void>;
    };
  }
}

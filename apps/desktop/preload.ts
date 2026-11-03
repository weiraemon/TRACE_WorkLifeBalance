import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('chaosDesktop', {
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('chaos:choose-directory'),
  setupQq: (input: { dataDir: string; selfQQ: string }): Promise<void> =>
    ipcRenderer.invoke('chaos:setup-qq', input),
});

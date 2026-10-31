import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('chaosDesktop', {
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('chaos:choose-directory'),
  setupQq: (): Promise<void> => ipcRenderer.invoke('chaos:setup-qq'),
});

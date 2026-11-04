import { createRoot } from 'react-dom/client';
import MobileApp from '../../web/src/features/mobile/MobileApp';
import { createAndroidTransport } from '../runtime/index';
import { androidRequest, installAndroidBridge } from '../../web/src/platform/android';
import { registerPlugin } from '@capacitor/core';
import { installPlatformTransport } from '../../web/src/platform/http';
import { applyTheme, readTheme } from '../../web/src/theme';
import '../../web/src/styles.css';
import {
  checkOperation,
  installOperationCancel,
  nativeOperationProgress,
  operationSnapshot,
  reportOperation,
} from '../../web/src/platform/operations';
import type { PluginListenerHandle } from '@capacitor/core';

const files = registerPlugin<{
  request(options: { method: string; input: unknown }): Promise<{ value: unknown }>;
  addListener(
    event: 'operationProgress',
    listener: typeof nativeOperationProgress,
  ): Promise<PluginListenerHandle>;
}>('ChaosFiles');
void files.addListener('operationProgress', nativeOperationProgress);
installOperationCancel((taskId) => files.request({ method: 'cancelOperation', input: { taskId } }));
installAndroidBridge(async (method, input) => {
  checkOperation();
  const result = await files.request({
    method,
    input: { ...(input as object), _taskId: operationSnapshot()?.id ?? '' },
  });
  checkOperation();
  return result.value;
});
installPlatformTransport(
  createAndroidTransport(androidRequest, (phase, completed, total) => {
    checkOperation();
    reportOperation(phase, completed, total);
  }),
);
applyTheme(readTheme());
createRoot(document.getElementById('root')!).render(<MobileApp />);

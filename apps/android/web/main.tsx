import { createRoot } from 'react-dom/client';
import MobileApp from '../../web/src/features/mobile/MobileApp';
import { createAndroidTransport } from '../runtime/index';
import { androidRequest, installAndroidBridge } from '../../web/src/platform/android';
import { registerPlugin } from '@capacitor/core';
import { installPlatformTransport } from '../../web/src/platform/http';
import { applyTheme, readTheme } from '../../web/src/theme';
import '../../web/src/styles.css';

const files = registerPlugin<{
  request(options: { method: string; input: unknown }): Promise<{ value: unknown }>;
}>('ChaosFiles');
installAndroidBridge(async (method, input) => (await files.request({ method, input })).value);
installPlatformTransport(createAndroidTransport(androidRequest));
applyTheme(readTheme());
createRoot(document.getElementById('root')!).render(<MobileApp />);

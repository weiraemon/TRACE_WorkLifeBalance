import type { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = {
  appId: 'com.chaos.workbench',
  appName: 'CHAOS',
  loggingBehavior: 'none',
  backgroundColor: '#415A42',
  webDir: '.android-dist',
  android: { path: 'apps/android/native', allowMixedContent: false },
  server: { hostname: 'localhost', androidScheme: 'https' },
};
export default config;

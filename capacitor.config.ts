import type { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = {
  appId: 'com.chaos.workbench',
  appName: 'CHAOS',
  loggingBehavior: 'none',
  webDir: '.android-dist',
  android: { path: 'apps/android/native', allowMixedContent: false },
  server: { hostname: 'localhost', androidScheme: 'https' },
};
export default config;

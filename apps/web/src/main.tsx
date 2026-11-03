import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { applyTheme, readTheme } from './theme';
applyTheme(readTheme());
const root = createRoot(document.getElementById('root')!);
if (new URLSearchParams(location.search).get('ui') === 'android') {
  void import('./features/mobile/MobileApp').then(({ default: MobileApp }) =>
    root.render(<MobileApp />),
  );
} else root.render(<App />);

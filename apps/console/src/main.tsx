import '@rp/design-tokens/tokens.css';
import '@rp/ui-web/styles.css';
import './console.css';
import { createTranslator } from '@rp/i18n';
import { ThemeRoot } from '@rp/ui-web';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App.js';
import { ConsoleController } from './app/console-controller.js';
import { BrowserStorage } from './app/storage.js';

const report = (error: unknown): void => {
  globalThis.reportError(error);
};

// Missing text is a bug: loud in development, reported (not fatal) in production.
const translator = createTranslator(import.meta.env.DEV ? {} : { onError: report });
const controller = new ConsoleController({
  // The local server serves the console, so the API is on the same origin.
  baseUrl: '',
  storage: new BrowserStorage(),
  appVersion: import.meta.env.VITE_APP_VERSION ?? '0.1.0',
  onError: report,
});
void controller.start();

const root = document.getElementById('root');
if (root === null) throw new Error('The page has no #root element');
createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeRoot className="console-root">
        <App controller={controller} translator={translator} />
      </ThemeRoot>
    </BrowserRouter>
  </StrictMode>,
);

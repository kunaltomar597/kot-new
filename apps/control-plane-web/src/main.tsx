import '@rp/design-tokens/tokens.css';
import '@rp/ui-web/styles.css';
import './cp-web.css';
import { createTranslator } from '@rp/i18n';
import { ThemeRoot } from '@rp/ui-web';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App.js';
import { createServices } from './app/services.js';
import { browserTokenStorage } from './app/session.js';

const report = (error: unknown): void => {
  globalThis.reportError(error);
};

// Missing text is a bug: loud in development, reported (not fatal) in production.
const translator = createTranslator(import.meta.env.DEV ? {} : { onError: report });
// The Control Plane serves this app, so its API is on the same origin.
const services = createServices({ baseUrl: '', storage: browserTokenStorage() });

const root = document.getElementById('root');
if (root === null) throw new Error('The page has no #root element');
createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeRoot className="cp-root">
        <App services={services} translator={translator} />
      </ThemeRoot>
    </BrowserRouter>
  </StrictMode>,
);

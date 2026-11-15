import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './app.tsx';

const root = document.getElementById('root');
if (root) createRoot(root).render(<BrowserRouter><App /></BrowserRouter>);

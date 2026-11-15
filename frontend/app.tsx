import { NavLink, Route, Routes } from 'react-router';
import { JobsPage } from './jobs-page.tsx';
import { PrintConsole } from './print-console.tsx';
import { useConsole } from './use-console.ts';

export function App() {
  const consoleState = useConsole();
  return (
    <main>
      <header>
        <h1>弹幕打印控制台</h1>
        <a href={consoleState.status?.dyhubUrl ?? 'http://127.0.0.1:8757'}>
          返回 DyHub 控制台 <span aria-hidden="true">↗</span>
        </a>
      </header>
      <nav className="console-nav" aria-label="控制台导航">
        <NavLink to="/" end>直播间监听</NavLink>
        <NavLink to="/jobs">打印任务</NavLink>
      </nav>
      <Routes>
        <Route path="/" element={<PrintConsole {...consoleState} />} />
        <Route path="/jobs" element={<JobsPage />} />
      </Routes>
    </main>
  );
}

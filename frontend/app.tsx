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
      <div className="dashboard">
        <div className="console-column">
          <PrintConsole {...consoleState} />
        </div>
        <div className="jobs-column">
          <JobsPage />
        </div>
      </div>
    </main>
  );
}

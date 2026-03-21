import { useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar/Sidebar';
import ScheduleCalendar from './components/Calendar/ScheduleCalendar';
import LoginPage from './components/Auth/LoginPage';
import BoardPage2 from './components/Board/BoardPage2';
import { useAuthStore } from './store/useAuthStore';
import { useHistoryStore } from './store/useHistoryStore';
import './styles/global.css';

/** hash 기반 간단 라우팅 */
function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const handler = () => setHash(window.location.hash);
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  return hash;
}

function App() {
  const hash = useHashRoute();

  // #/board 일 때 게시판 페이지 (로그인 불필요)
  if (hash === '#/board') return <BoardPage2 />;

  return <MainApp />;
}

/** 기존 메인 앱 (로그인 필요) */
function MainApp() {
  const { session, loading, initialize } = useAuthStore();
  const loadedUserId = useRef<string | null>(null);

  useEffect(() => {
    initialize();
  }, [initialize]);

  // 로그인 후 클라우드 데이터 로드 (유저 변경 시 재로드)
  useEffect(() => {
    const userId = session?.user?.id ?? null;
    if (!userId || loadedUserId.current === userId) return;
    loadedUserId.current = userId;

    async function loadData() {
      const loaded = await useHistoryStore.getState().loadFromCloud();
      if (!loaded) {
        // 클라우드에 데이터 없으면 localStorage 폴백
        useHistoryStore.getState().load();
      }
    }
    loadData();
  }, [session]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#888' }}>
        로딩 중...
      </div>
    );
  }

  if (!session) {
    return <LoginPage />;
  }

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <ScheduleCalendar />
      </main>
    </div>
  );
}

export default App;

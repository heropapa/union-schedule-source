import { useState } from 'react';
import { useAuthStore } from '../../store/useAuthStore';
import { toEmail } from '../../lib/supabase';
import './LoginPage.css';

type Mode = 'login' | 'signup';

export default function LoginPage() {
  const { login, signup, loading, error, kickedOut } = useAuthStore();
  const [mode, setMode] = useState<Mode>('login');
  const [userId, setUserId] = useState('admin');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!userId || !password) return;
    await login(toEmail(userId), password);
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    if (!userId || !password || !displayName) return;
    if (password !== passwordConfirm) {
      useAuthStore.setState({ error: '비밀번호가 일치하지 않습니다' });
      return;
    }
    if (password.length < 6) {
      useAuthStore.setState({ error: '비밀번호는 6자 이상이어야 합니다' });
      return;
    }
    const ok = await signup(toEmail(userId), password, displayName);
    if (ok) {
      setSuccessMsg('회원가입 완료! 로그인해주세요.');
      setMode('login');
      setPassword('');
      setPasswordConfirm('');
    }
  }

  function switchMode(newMode: Mode) {
    setMode(newMode);
    setPassword('');
    setPasswordConfirm('');
    setSuccessMsg('');
    useAuthStore.setState({ error: null });
  }

  if (mode === 'signup') {
    return (
      <div className="login-page">
        <form className="login-card" onSubmit={handleSignup}>
          <h1>회원가입</h1>
          <p className="login-subtitle">새 계정을 만들어주세요</p>

          {error && <div className="login-error">{error}</div>}

          <div className="login-field">
            <label>아이디</label>
            <input
              type="text"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="사용할 아이디 입력"
              autoComplete="username"
              autoFocus
            />
          </div>

          <div className="login-field">
            <label>이름 (표시용)</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="예: 홍길동"
              autoComplete="name"
            />
          </div>

          <div className="login-field">
            <label>비밀번호</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="6자 이상"
              autoComplete="new-password"
            />
          </div>

          <div className="login-field">
            <label>비밀번호 확인</label>
            <input
              type="password"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
              placeholder="비밀번호 다시 입력"
              autoComplete="new-password"
            />
          </div>

          <button className="login-btn" type="submit" disabled={loading}>
            {loading ? '가입 중...' : '회원가입'}
          </button>

          <p className="login-switch">
            이미 계정이 있나요?{' '}
            <button type="button" onClick={() => switchMode('login')}>
              로그인
            </button>
          </p>
        </form>
      </div>
    );
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleLogin}>
        <h1>주식회사 넥스트유니온<br/>스케쥴 관리 프로그램</h1>
        <p className="login-subtitle">로그인하여 스케줄을 확인하세요</p>

        {kickedOut && <div className="login-error">다른 기기에서 로그인하여 현재 세션이 종료되었습니다.<br/>다시 로그인해주세요.</div>}
        {successMsg && <div className="login-success">{successMsg}</div>}
        {error && !kickedOut && <div className="login-error">{error}</div>}

        <div className="login-field">
          <label>아이디</label>
          <input
            type="text"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="아이디 입력"
            autoComplete="username"
            autoFocus
          />
        </div>

        <div className="login-field">
          <label>비밀번호</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="비밀번호 입력"
            autoComplete="current-password"
          />
        </div>

        <button className="login-btn" type="submit" disabled={loading}>
          {loading ? '로그인 중...' : '로그인'}
        </button>

        <p className="login-contact">
          문의 및 권한요청: 임지현 010-3478-4253
        </p>
      </form>
    </div>
  );
}

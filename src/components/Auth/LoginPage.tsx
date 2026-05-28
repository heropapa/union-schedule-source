import { useState } from 'react';
import { useAuthStore } from '../../store/useAuthStore';
import { toEmail } from '../../lib/supabase';
import './LoginPage.css';

/**
 * 로그인 페이지.
 *
 * 회원가입은 admin이 Supabase 대시보드에서 직접 생성하는 정책이므로
 * 이 페이지는 로그인 전용. 권한 요청은 임지현 010-3478-4253.
 *
 * (이전엔 미사용 signup 모드 코드가 남아있어 useAuthStore.signup
 *  미정의로 TS2339 에러 발생했음 — 2026-05-27 제거)
 */
export default function LoginPage() {
  const { login, loading, error } = useAuthStore();
  const [userId, setUserId] = useState('admin');
  const [password, setPassword] = useState('');

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!userId || !password) return;
    await login(toEmail(userId), password);
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleLogin}>
        <h1>주식회사 넥스트유니온<br/>스케쥴 관리 프로그램</h1>
        <p className="login-subtitle">로그인하여 스케줄을 확인하세요</p>

        {error && <div className="login-error">{error}</div>}

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

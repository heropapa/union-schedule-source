import { useEffect, useState, useCallback } from 'react';
import * as db from '../../lib/db';
import type { UserProfile } from '../../lib/db';
import { toDisplayName } from '../../lib/supabase';
import './AccountManager.css';

/**
 * admin 전용 계정 관리.
 * 계정 추가 / 비밀번호 변경 / 권한(admin·viewer) 변경 / 삭제.
 * 모든 작업은 SECURITY DEFINER RPC(admin_*)를 통해 수행 (v1.5 SQL 필요).
 */
export default function AccountManager({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 새 계정 입력
  const [newName, setNewName] = useState('');
  const [newPw, setNewPw] = useState('5020');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setUsers(await db.fetchAllUsers());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  function fail(e: unknown) {
    setErr(e instanceof Error ? e.message : JSON.stringify(e));
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name || !newPw) return;
    setBusy(true); setErr(null);
    try {
      await db.adminCreateUser(name, newPw, 'viewer');
      setNewName(''); setNewPw('5020');
      await reload();
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function handleResetPw(name: string) {
    const pw = prompt(`"${name}" 의 새 비밀번호를 입력하세요`, '5020');
    if (pw == null || pw === '') return;
    setBusy(true); setErr(null);
    try { await db.adminSetPassword(name, pw); alert('비밀번호가 변경되었습니다.'); }
    catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function handleToggleRole(name: string, current: string) {
    const next = current === 'admin' ? 'viewer' : 'admin';
    if (!confirm(`"${name}" 권한을 ${next === 'admin' ? '관리자' : '뷰어'}로 변경할까요?`)) return;
    setBusy(true); setErr(null);
    try { await db.adminSetRole(name, next); await reload(); }
    catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function handleDelete(name: string) {
    if (!confirm(`"${name}" 계정을 삭제할까요? 되돌릴 수 없습니다.`)) return;
    setBusy(true); setErr(null);
    try { await db.adminDeleteUser(name); await reload(); }
    catch (e) { fail(e); } finally { setBusy(false); }
  }

  return (
    <div className="acct-overlay" onClick={() => !busy && onClose()}>
      <div className="acct-modal" onClick={(e) => e.stopPropagation()}>
        <div className="acct-head">
          <h3>계정 관리</h3>
          <button className="acct-x" onClick={onClose}>&times;</button>
        </div>

        {err && <div className="acct-error">{err}</div>}

        {/* 새 계정 추가 */}
        <div className="acct-add">
          <input
            className="acct-input"
            placeholder="성함 (로그인 아이디)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
          />
          <input
            className="acct-input"
            placeholder="비밀번호"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
          />
          <button className="acct-add-btn" onClick={handleCreate} disabled={busy || !newName.trim() || !newPw}>
            추가
          </button>
        </div>

        {/* 목록 */}
        {loading ? (
          <div className="acct-empty">불러오는 중…</div>
        ) : (
          <table className="acct-table">
            <thead>
              <tr><th>성함</th><th>권한</th><th>작업</th></tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const name = toDisplayName(u.email) || u.displayName;
                const isAdmin = u.role === 'admin';
                return (
                  <tr key={u.id}>
                    <td>{u.displayName || name}</td>
                    <td>
                      <button
                        className={`acct-role ${isAdmin ? 'admin' : 'viewer'}`}
                        onClick={() => handleToggleRole(name, u.role)}
                        disabled={busy}
                        title="클릭하여 권한 변경"
                      >
                        {isAdmin ? '관리자' : '뷰어'}
                      </button>
                    </td>
                    <td className="acct-actions">
                      <button onClick={() => handleResetPw(name)} disabled={busy}>비번변경</button>
                      <button
                        className="acct-del"
                        onClick={() => handleDelete(name)}
                        disabled={busy || name === 'admin'}
                      >
                        삭제
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <p className="acct-hint">
          비밀번호는 입력한 그대로 로그인에 사용됩니다 (예: 5020). 새 계정 권한은 기본 "뷰어"이며,
          캠프별 편집 권한은 사이드바 캠프의 ▸ 메뉴에서 부여하세요.
        </p>
      </div>
    </div>
  );
}

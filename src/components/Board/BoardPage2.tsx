import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { format, addDays, startOfWeek } from 'date-fns';
import type { CellStatus } from '../../types';
import './BoardPage.css';
import './BoardPage2.css';

/**
 * 공개 스케쥴 게시판 (v1.1 주간).
 * 로그인 없이 anon 키로 "게시판에 공개(published)"된 캠프의 이번 주 스케줄만 열람.
 * 필요한 anon RLS 정책: supabase/v1.8-board-rls.sql
 */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const boardSupabase = createClient(supabaseUrl, supabaseAnonKey, {
  // 별도 storageKey로 메인 클라이언트와 auth lock/저장키를 분리
  // (같은 키를 공유하면 "Multiple GoTrueClient instances" 로 로그인이 교착)
  auth: { persistSession: false, autoRefreshToken: false, storageKey: 'usp-board-anon' },
});

const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

type BW = {
  id: string; name: string; loginId: string; role: 'regular' | 'backup';
  assignedRoutes: string[]; rotations: string[];
};
type BCamp = { id: string; name: string; wave: string; color: string };
type Cell = { status: CellStatus; routes: string[] };
type CampBlock = { camp: BCamp; regulars: BW[]; backups: BW[]; cells: Record<string, Cell> };

export default function BoardPage2() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<CampBlock[]>([]);

  const weekStart = startOfWeek(new Date(), { weekStartsOn: 0 });
  const weekDates = Array.from({ length: 7 }, (_, i) => format(addDays(weekStart, i), 'yyyy-MM-dd'));
  const weekLabel = format(weekStart, 'yyyy년 M월 d일') + ' 주';

  useEffect(() => {
    (async () => {
      try {
        const wk = format(weekStart, 'yyyy-MM-dd');
        const { data: campRows, error: ce } = await boardSupabase
          .from('camps').select('*').eq('published', true).order('sort_order');
        if (ce) throw new Error('캠프 로드 실패: ' + ce.message);

        const result: CampBlock[] = [];
        for (const cr of campRows ?? []) {
          const camp: BCamp = { id: cr.id, name: cr.name, wave: cr.wave, color: cr.color };
          // 이번 주 roster
          const { data: rosterRows } = await boardSupabase
            .from('weekly_rosters').select('id').eq('camp_id', cr.id).eq('week_start', wk).limit(1);
          const roster = rosterRows?.[0];
          let regulars: BW[] = [], backups: BW[] = [];
          const cells: Record<string, Cell> = {};
          if (roster) {
            const { data: wRows } = await boardSupabase
              .from('workers').select('*').eq('weekly_roster_id', roster.id).order('sort_order');
            const workers: BW[] = (wRows ?? []).map((r) => ({
              id: r.id, name: r.name, loginId: r.login_id, role: r.role,
              assignedRoutes: r.assigned_routes ?? [], rotations: r.rotations ?? [],
            }));
            regulars = workers.filter((w) => w.role === 'regular');
            backups = workers.filter((w) => w.role === 'backup');
            const { data: cRows } = await boardSupabase
              .from('schedule_cells').select('*')
              .eq('camp_id', cr.id).gte('date', weekDates[0]).lte('date', weekDates[6]);
            for (const c of cRows ?? []) {
              cells[`${c.worker_id}::${c.date}`] = { status: c.status, routes: c.routes ?? [] };
            }
          }
          result.push({ camp, regulars, backups, cells });
        }
        setBlocks(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : '알 수 없는 오류');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function effectiveCell(w: BW, date: string, cells: Record<string, Cell>): Cell | undefined {
    const c = cells[`${w.id}::${date}`];
    if (c) return c;
    if (w.role === 'regular') return { status: 'work', routes: w.assignedRoutes };
    return undefined;
  }
  function cellText(ec: Cell | undefined): string {
    if (!ec) return '';
    if (ec.status === 'off') return '휴';
    if (ec.status === 'custom') return ec.routes.join(', ') || '직접';
    if (ec.status === 'work') return ec.routes.join(', ') || '근';
    return '';
  }
  function cellClass(ec: Cell | undefined): string {
    if (!ec) return 'bcell-empty';
    if (ec.status === 'off') return 'bcell-off';
    if (ec.status === 'custom') return 'bcell-custom';
    if (ec.status === 'work') return 'bcell-work';
    return 'bcell-empty';
  }

  function renderRows(list: BW[], label: string, cells: Record<string, Cell>) {
    if (list.length === 0) return null;
    return (
      <>
        <tr className="brow-section"><td colSpan={weekDates.length + 1}>{label}</td></tr>
        {list.map((w) => (
          <tr key={w.id}>
            <td className="bname">{w.name}</td>
            {weekDates.map((d) => {
              const ec = effectiveCell(w, d, cells);
              return <td key={d} className={`bcell ${cellClass(ec)}`}>{cellText(ec)}</td>;
            })}
          </tr>
        ))}
      </>
    );
  }

  return (
    <div className="board-page">
      <div className="board-topbar">
        <a className="board-back-btn" href="#/" onClick={() => { window.location.hash = ''; }}>
          ← 스케줄 관리(로그인)
        </a>
      </div>
      <div className="board-header">
        <h1>📋 스케쥴 게시판</h1>
        <p className="board-week">{weekLabel}</p>
        <p className="board-note">본인 이름을 찾아 이번 주 근무를 확인하세요. (근무=라우트/근, 휴무=휴)</p>
      </div>

      {loading && <div className="board-msg">불러오는 중…</div>}
      {error && (
        <div className="board-msg board-err">
          불러오기 오류: {error}<br />
          <small>공개 열람 설정(RLS)이 적용됐는지 확인이 필요할 수 있어요.</small>
        </div>
      )}
      {!loading && !error && blocks.length === 0 && (
        <div className="board-msg">공개된 캠프가 없습니다. (관리자가 캠프를 "게시판에 공개"로 설정해야 보입니다.)</div>
      )}

      {!loading && !error && blocks.map(({ camp, regulars, backups, cells }) => (
        <div className="board-camp" key={camp.id}>
          <h2 className="board-camp-title">
            <span className="camp-dot" style={{ background: camp.color || '#888' }} />
            {camp.name}
            <span className="board-wave">{camp.wave === 'WAVE2' ? '주간' : '야간'}</span>
          </h2>
          {regulars.length === 0 && backups.length === 0 ? (
            <div className="board-msg board-empty-camp">이번 주 등록된 인원이 없습니다.</div>
          ) : (
            <div className="board-table-wrap">
              <table className="board-table">
                <thead>
                  <tr>
                    <th className="bname">이름</th>
                    {weekDates.map((d, i) => (
                      <th key={d}>{DAY_LABELS[i]}<br /><span className="bdate">{d.slice(5)}</span></th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {renderRows(regulars, '고정 인원', cells)}
                  {renderRows(backups, '백업 인원', cells)}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

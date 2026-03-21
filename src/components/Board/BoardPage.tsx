import React, { useEffect, useState, useMemo } from 'react';
import { createClient } from '@supabase/supabase-js';
import { format, addDays, startOfMonth, endOfMonth, startOfWeek, endOfWeek, addMonths, isSameMonth } from 'date-fns';
import { ko } from 'date-fns/locale/ko';
import type { Worker, Route, ScheduleCell, Camp } from '../../types';
import './BoardPage.css';

/* ── atone 계정 정보 ── */
const ATONE_EMAIL = 'atone@schedule.local';
const ATONE_PW = '150527';
const ATONE_UID = 'a3451236-bf21-410f-96e3-57883c252025';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

const boardSupabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface Snapshot {
  workers: Worker[];
  routes: Record<string, Route[]>;
  cells: Record<string, ScheduleCell>;
  camps?: Camp[];
}

const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

type WaveTab = 'WAVE1' | 'WAVE2';
const WAVE_LABELS: Record<WaveTab, string> = { WAVE1: '야간', WAVE2: '주간' };

/** 달력 그리드용 날짜 배열 */
function buildCalendarDates(year: number, month: number): Date[] {
  const monthStart = startOfMonth(new Date(year, month, 1));
  const monthEnd = endOfMonth(monthStart);
  const calStart = startOfWeek(monthStart, { weekStartsOn: 0 });
  const calEnd = endOfWeek(monthEnd, { weekStartsOn: 0 });
  const dates: Date[] = [];
  let d = calStart;
  while (d <= calEnd) {
    dates.push(d);
    d = addDays(d, 1);
  }
  return dates;
}

export default function BoardPage() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedCamp, setExpandedCamp] = useState<string | null>(null);
  const [waveTab, setWaveTab] = useState<WaveTab>('WAVE2');
  const [detailDate, setDetailDate] = useState<string | null>(null);

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const todayStr = format(today, 'yyyy-MM-dd');

  const months = useMemo(() => {
    const m1 = { year: today.getFullYear(), month: today.getMonth() };
    const next = addMonths(today, 1);
    const m2 = { year: next.getFullYear(), month: next.getMonth() };
    return [m1, m2];
  }, [today]);

  /* 데이터 로드 */
  useEffect(() => {
    (async () => {
      try {
        const { error: authErr } = await boardSupabase.auth.signInWithPassword({
          email: ATONE_EMAIL, password: ATONE_PW,
        });
        if (authErr) throw new Error('인증 실패: ' + authErr.message);

        const { data, error: dlErr } = await boardSupabase.storage
          .from('snapshots')
          .download(`${ATONE_UID}/schedule.json`);

        if (dlErr || !data) throw new Error('데이터 로드 실패');
        setSnap(JSON.parse(await data.text()) as Snapshot);
      } catch (e: any) {
        setError(e.message || '알 수 없는 오류');
      } finally {
        setLoading(false);
        boardSupabase.auth.signOut();
      }
    })();
  }, []);

  function getEffectiveCell(worker: Worker, date: string): { status: string; routes: string[] } | undefined {
    if (!snap) return undefined;
    const cell = snap.cells[`${worker.id}::${date}`];
    if (cell) return cell;
    if (worker.role === 'regular') return { status: 'work', routes: worker.assignedRoutes };
    return undefined;
  }

  function getDaySummary(date: string, regulars: Worker[], backups: Worker[], camp: Camp) {
    const offWorkers = regulars.filter((w) => getEffectiveCell(w, date)?.status === 'off');
    const activeBackups = backups.filter((w) => {
      const cell = getEffectiveCell(w, date);
      return cell && (cell.status === 'work' || cell.status === 'custom') && cell.routes.length > 0;
    });
    const campRoutes = snap!.routes[camp.id];
    const allSubs = campRoutes ? campRoutes.flatMap((r) => r.subRoutes) : [];
    const covered = new Set<string>();
    [...regulars, ...backups].forEach((w) => {
      const cell = getEffectiveCell(w, date);
      if (cell && (cell.status === 'work' || cell.status === 'custom')) {
        cell.routes.forEach((r) => covered.add(r));
      }
    });
    const uncovered = allSubs.filter((r) => !covered.has(r));
    return { offWorkers, activeBackups, uncovered };
  }

  const campGroups = useMemo(() => {
    if (!snap) return [];
    return (snap.camps || [])
      .filter((camp) => (camp.wave || 'WAVE1') === waveTab)
      .map((camp) => {
        const workers = snap.workers.filter((w) => w.campId === camp.id);
        const workerIds = new Set(workers.map((w) => w.id));
        const hasCells = Object.keys(snap.cells).some((k) => workerIds.has(k.split('::')[0]));
        return { camp, regulars: workers.filter((w) => w.role === 'regular'), backups: workers.filter((w) => w.role === 'backup'), hasCells };
      });
  }, [snap, waveTab]);

  useEffect(() => { setExpandedCamp(null); setDetailDate(null); }, [waveTab]);

  if (loading) return <div className="board-loading"><div className="board-spinner" /><p>스케쥴 불러오는 중...</p></div>;
  if (error) return <div className="board-error"><p>⚠️ {error}</p><button onClick={() => window.location.reload()}>새로고침</button></div>;

  return (
    <div className="board-container">
      <header className="board-header">
        <h1>📋 스케쥴 게시판</h1>
      </header>

      <div className="wave-tabs">
        {(['WAVE2', 'WAVE1'] as WaveTab[]).map((w) => (
          <button key={w} className={`wave-tab ${waveTab === w ? 'active' : ''}`} onClick={() => setWaveTab(w)}>
            {WAVE_LABELS[w]}
          </button>
        ))}
      </div>

      <div className="board-camps">
        {campGroups.length === 0 && <div className="board-empty">등록된 캠프가 없습니다</div>}
        {campGroups.map(({ camp, regulars, backups, hasCells }) => {
          const isExpanded = expandedCamp === camp.id;
          const hasWorkers = regulars.length > 0 || backups.length > 0;
          const showCalendar = hasWorkers && hasCells;
          return (
            <section key={camp.id} className="board-camp">
              <button
                className={`camp-toggle ${isExpanded ? 'expanded' : ''} ${!showCalendar ? 'empty-camp' : ''}`}
                style={{ borderLeftColor: camp.color }}
                onClick={() => { setExpandedCamp(isExpanded ? null : camp.id); setDetailDate(null); }}
              >
                <span className="camp-name">{camp.name}</span>
                <span className="camp-arrow">{isExpanded ? '▲' : '▼'}</span>
              </button>

              {isExpanded && (
                <div className="camp-calendar-wrap">
                  {!showCalendar ? (
                    <div className="camp-no-workers">등록된 스케쥴이 없습니다</div>
                  ) : (
                    months.map(({ year, month }) => {
                      const calDates = buildCalendarDates(year, month);
                      const monthRef = new Date(year, month, 1);
                      const weeks: Date[][] = [];
                      for (let i = 0; i < calDates.length; i += 7) weeks.push(calDates.slice(i, i + 7));

                      return (
                        <div key={`${year}-${month}`} className="cal-month">
                          <div className="cal-month-title">{format(monthRef, 'yyyy년 M월')}</div>
                          <table className="cal-table">
                            <thead>
                              <tr>
                                {DAY_LABELS.map((label, i) => (
                                  <th key={i} className={i === 0 ? 'sun' : i === 6 ? 'sat' : ''}>{label}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {weeks.map((week, wi) => {
                                /* 이 주에 선택된 날짜가 있는지 */
                                const weekDates = week.map((wd) => format(wd, 'yyyy-MM-dd'));
                                const hasDetail = detailDate && weekDates.includes(detailDate);

                                /* 주간 요약 미리 계산 → 최대 줄 수로 높이 통일 */
                                const weekSummaries = week.map((d, i) => {
                                  const inMonth = isSameMonth(d, monthRef);
                                  return inMonth && hasWorkers ? getDaySummary(weekDates[i], regulars, backups, camp) : null;
                                });
                                const maxOff = Math.max(0, ...weekSummaries.map((s) => s?.offWorkers.length ?? 0));
                                const maxBackup = Math.max(0, ...weekSummaries.map((s) => s?.activeBackups.length ?? 0));
                                const maxUncovered = Math.max(0, ...weekSummaries.map((s) => s?.uncovered.length ?? 0));

                                /* 칩 높이(px) 기준으로 섹션 최소높이 계산 */
                                const CHIP_H = 17;
                                const LABEL_H = 14;
                                const offMinH = maxOff > 0 ? LABEL_H + maxOff * CHIP_H : 0;
                                const backupMinH = maxBackup > 0 ? LABEL_H + maxBackup * CHIP_H : 0;
                                const uncoveredMinH = maxUncovered > 0 ? LABEL_H + maxUncovered * CHIP_H : 0;

                                return (
                                  <React.Fragment key={wi}>
                                    <tr>
                                      {week.map((d, di) => {
                                        const dateStr = weekDates[di];
                                        const inMonth = isSameMonth(d, monthRef);
                                        const isToday = dateStr === todayStr;
                                        const dayIdx = d.getDay();
                                        const summary = weekSummaries[di];

                                        return (
                                          <td
                                            key={di}
                                            className={[
                                              !inMonth ? 'out-month' : '',
                                              isToday ? 'cal-today' : '',
                                              dateStr === detailDate ? 'cal-selected' : '',
                                              dayIdx === 0 ? 'sun' : dayIdx === 6 ? 'sat' : '',
                                            ].filter(Boolean).join(' ')}
                                            onClick={() => { if (inMonth) setDetailDate(dateStr === detailDate ? null : dateStr); }}
                                          >
                                            <div className="cal-day-num-wrap">
                                              <span className={`cal-day-num ${isToday ? 'today-circle' : ''}`}>
                                                {d.getDate()}
                                              </span>
                                            </div>
                                            {summary && inMonth && (
                                              <div className="cal-cell-content">
                                                {maxOff > 0 && (
                                                  <div className="cell-section cell-off" style={{ minHeight: offMinH }}>
                                                    {summary.offWorkers.length > 0 && (
                                                      <>
                                                        <span className="cell-section-label off-label">휴무</span>
                                                        <div className="cell-names">
                                                          {summary.offWorkers.map((w) => (
                                                            <span key={w.id} className="cell-off-name">{w.name}</span>
                                                          ))}
                                                        </div>
                                                      </>
                                                    )}
                                                  </div>
                                                )}
                                                {maxBackup > 0 && (
                                                  <div className="cell-section cell-backup" style={{ minHeight: backupMinH }}>
                                                    {summary.activeBackups.length > 0 && (
                                                      <>
                                                        <span className="cell-section-label backup-label">백업</span>
                                                        <div className="cell-names">
                                                          {summary.activeBackups.map((w) => {
                                                            const cell = getEffectiveCell(w, dateStr)!;
                                                            return (
                                                              <span key={w.id} className="cell-backup-name">
                                                                {w.name} <span className="cell-route-text">{cell.routes.join(',')}</span>
                                                              </span>
                                                            );
                                                          })}
                                                        </div>
                                                      </>
                                                    )}
                                                  </div>
                                                )}
                                                {maxUncovered > 0 && (
                                                  <div className="cell-section cell-uncovered" style={{ minHeight: uncoveredMinH }}>
                                                    {summary.uncovered.length > 0 && (
                                                      <>
                                                        <span className="cell-section-label uncovered-label">미커버</span>
                                                        <div className="cell-names">
                                                          {summary.uncovered.map((r) => (
                                                            <span key={r} className="cell-uncovered-route">{r}</span>
                                                          ))}
                                                        </div>
                                                      </>
                                                    )}
                                                  </div>
                                                )}
                                              </div>
                                            )}
                                          </td>
                                        );
                                      })}
                                    </tr>

                                    {/* 상세 패널: 해당 주 바로 아래 */}
                                    {hasDetail && (() => {
                                      const dd = new Date(detailDate + 'T00:00:00');
                                      const s = getDaySummary(detailDate, regulars, backups, camp);
                                      return (
                                        <tr className="detail-row">
                                          <td colSpan={7}>
                                            <div className="cal-detail">
                                              <div className="cal-detail-header">
                                                <span className="cal-detail-date">
                                                  {format(dd, 'M월 d일 (EEE)', { locale: ko })}
                                                </span>
                                                <button className="cal-detail-close" onClick={() => setDetailDate(null)}>✕</button>
                                              </div>
                                              {s.offWorkers.length > 0 && (
                                                <div className="detail-section">
                                                  <div className="detail-label off-label">🏖️ 휴무 ({s.offWorkers.length}명)</div>
                                                  <div className="detail-chips">
                                                    {s.offWorkers.map((w) => (
                                                      <span key={w.id} className="chip chip-off">{w.name} <span className="chip-route">{w.assignedRoutes.join(', ')}</span></span>
                                                    ))}
                                                  </div>
                                                </div>
                                              )}
                                              {s.activeBackups.length > 0 && (
                                                <div className="detail-section">
                                                  <div className="detail-label backup-label">🔄 백업 현황 ({s.activeBackups.length}명)</div>
                                                  <div className="detail-chips">
                                                    {s.activeBackups.map((w) => {
                                                      const cell = getEffectiveCell(w, detailDate)!;
                                                      return (
                                                        <span key={w.id} className="chip chip-backup">
                                                          {w.name} → <span className="chip-route">{cell.routes.join(', ')}</span>
                                                        </span>
                                                      );
                                                    })}
                                                  </div>
                                                </div>
                                              )}
                                              {s.uncovered.length > 0 && (
                                                <div className="detail-section">
                                                  <div className="detail-label uncovered-label">⚠️ 미커버 ({s.uncovered.length}개)</div>
                                                  <div className="detail-chips">
                                                    {s.uncovered.map((r) => (
                                                      <span key={r} className="chip chip-uncovered">{r}</span>
                                                    ))}
                                                  </div>
                                                </div>
                                              )}
                                              {s.offWorkers.length === 0 && s.activeBackups.length === 0 && s.uncovered.length === 0 && (
                                                <div className="detail-nothing">휴무자 없음</div>
                                              )}
                                            </div>
                                          </td>
                                        </tr>
                                      );
                                    })()}
                                  </React.Fragment>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <footer className="board-footer">
        <a href="#/board" className="back-link">테이블 뷰 →</a>
        {' · '}
        <a href="#/" className="back-link">관리 페이지</a>
      </footer>
    </div>
  );
}

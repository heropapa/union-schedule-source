/**
 * 구글시트에서 스케쥴 직접 가져오기.
 *
 * 실무 스프레드시트에 이미 어드민 양식 컬럼(업무일|캠프명|웨이브|아이디|업무상태|회전|업무라우트)이
 * 있으므로, 링크 공유된 시트를 gviz CSV로 읽어 그 블록을 찾아 현재 캠프·주차 행만 적용한다.
 * 검증/리포트는 기존 어드민 업로드 파이프라인(matchImportRows)을 재사용.
 */
import type { ScheduleCell, Worker, CellStatus } from '../types';
import { matchImportRows, type ImportRow } from './importAdminExcel';
import type { ScheduleImportResult, ImportError } from './importScheduleExcel';

/** 구글시트 URL → 시트 ID */
export function extractSheetId(url: string): string | null {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

/** 간단 CSV 파서 (따옴표/줄바꿈 처리) */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      row.push(cur); cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      rows.push(row); row = [];
    } else {
      cur += ch;
    }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const trim = (v: string | undefined) => (v ?? '').trim();
const splitList = (v: string | undefined) =>
  trim(v).split(',').map((s) => s.trim()).filter(Boolean);

/** 'yyyy-mm-dd' 정규화 (2026-08-16, 2026.8.16, 2026/08/16 허용) */
function normDate(v: string): string | null {
  const m = trim(v).match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/**
 * 시트 CSV 전체에서 어드민 양식 블록들을 찾아 ImportRow[] 로.
 * 헤더 행에 '업무일'과 '아이디'가 함께 있는 컬럼 그룹을 블록으로 인식.
 * (한 행에 A/B/C/D주 블록이 옆으로 여러 개 있어도 모두 처리)
 */
function extractAdminRows(rows: string[][]): ImportRow[] {
  const out: ImportRow[] = [];
  // 헤더 행 찾기: '사업자등록번호'(또는 '업무일')가 들어있는 행.
  // (gviz CSV는 '업무일' 헤더 칸을 비워버리는 경우가 있어 '사업자등록번호' 기준으로 블록 인식,
  //  업무일 컬럼은 그 바로 왼쪽 칸으로 잡는다)
  for (let hr = 0; hr < rows.length; hr++) {
    const header = rows[hr];
    const anchors: { idx: number; kind: 'biz' | 'date' }[] = [];
    header.forEach((c, i) => {
      const h = trim(c);
      if (h === '사업자등록번호') anchors.push({ idx: i, kind: 'biz' });
      else if (h === '업무일') anchors.push({ idx: i, kind: 'date' });
    });
    if (anchors.length === 0) continue;

    // '업무일'과 '사업자등록번호'가 나란히 있으면 같은 블록 — biz 기준으로 중복 제거
    const bizAnchors = anchors.filter((a) => a.kind === 'biz');
    const blocks = bizAnchors.length > 0
      ? bizAnchors.map((a) => ({ dateCol: trim(header[a.idx - 1]) === '업무일' || trim(header[a.idx - 1]) === '' ? a.idx - 1 : a.idx - 1, start: a.idx }))
      : anchors.map((a) => ({ dateCol: a.idx, start: a.idx + 1 }));

    for (const b of blocks) {
      const col: Record<string, number> = {};
      for (let i = b.start; i < Math.min(b.start + 10, header.length); i++) {
        const h = trim(header[i]);
        if (h && col[h] === undefined) col[h] = i;
      }
      if (col['아이디'] === undefined && col['이름'] === undefined) continue;

      for (let r = hr + 1; r < rows.length; r++) {
        const row = rows[r];
        if (!row) continue;
        const date = normDate(row[b.dateCol] ?? '');
        if (!date) continue;
        const name = trim(row[col['이름'] ?? -1]);
        const loginId = trim(row[col['아이디'] ?? -1]);
        if ((!name || name === '0') && (!loginId || loginId.includes('N/A'))) continue;
        out.push({
          rowNum: r + 1,
          date,
          campName: trim(row[col['캠프명'] ?? -1]),
          wave: trim(row[col['웨이브'] ?? -1]),
          name: name === '0' ? '' : name,
          loginId: loginId.includes('N/A') ? '' : loginId,
          status: trim(row[col['업무상태'] ?? -1]) || '출근',
          rotations: splitList(row[col['회전'] ?? -1]),
          routes: splitList(row[col['업무라우트'] ?? -1]),
        });
      }
    }
  }
  return out;
}

/** 링크 공유된 구글시트에서 CSV 가져오기 (gviz). sheetName 생략 시 첫 시트. */
export async function fetchGoogleSheetCsv(sheetId: string, sheetName?: string): Promise<string> {
  const base = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv`;
  const url = sheetName ? `${base}&sheet=${encodeURIComponent(sheetName)}` : base;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`구글시트를 읽을 수 없습니다 (HTTP ${res.status}). 시트가 "링크가 있는 모든 사용자 보기"로 공유돼 있는지 확인하세요.`);
  }
  const text = await res.text();
  if (text.trimStart().startsWith('<')) {
    throw new Error('구글시트 응답이 CSV가 아닙니다. 공유 설정(링크 보기 허용) 또는 시트 이름을 확인하세요.');
  }
  return text;
}

/** 구글시트 → 현재 캠프·주차 셀 + 검증 리포트 */
export async function importFromGoogleSheet(
  sheetId: string,
  sheetName: string,
  ctx: { campId: string; campName: string; weekDates: string[]; workers: Worker[] },
): Promise<ScheduleImportResult> {
  const csv = await fetchGoogleSheetCsv(sheetId, sheetName || undefined);
  const grid = parseCsv(csv);
  const allRows = extractAdminRows(grid);
  if (allRows.length === 0) {
    throw new Error("시트에서 어드민 양식(업무일/아이디/업무상태 컬럼)을 찾지 못했습니다. 시트 이름이 맞는지 확인하세요.");
  }

  // 현재 주차 행만 사용 (다른 주는 건수만 안내)
  const weekSet = new Set(ctx.weekDates);
  const inWeek = allRows.filter((r) => weekSet.has(r.date));
  const skippedOtherWeeks = allRows.length - inWeek.length;

  const errors: ImportError[] = [];

  // 캠프명 안전장치 (시트의 캠프명이 있고 현재 캠프와 다르면 거부)
  const sheetCamp = inWeek.find((r) => r.campName)?.campName ?? '';
  if (sheetCamp && ctx.campName && sheetCamp !== ctx.campName) {
    return {
      applicable: [],
      errors: [{ row: 1, reason: `시트 캠프(${sheetCamp})가 현재 캠프(${ctx.campName})와 다릅니다.` }],
      appliedCount: 0,
      format: '어드민',
    };
  }

  const result = matchImportRows(inWeek, ctx.workers, ctx.campId);
  const applicable: ScheduleCell[] = result.matched.map((m) => ({
    workerId: m.worker.id,
    date: m.row.date,
    status: (m.row.status === '휴무' ? 'off' : 'work') as CellStatus,
    routes: m.row.status === '휴무' ? [] : m.row.routes,
  }));
  errors.push(...result.mismatched.map((mm) => ({ row: mm.row.rowNum, reason: mm.reason })));
  if (skippedOtherWeeks > 0) {
    errors.push({ row: 0, reason: `현재 주차(${ctx.weekDates[0]}~) 밖 ${skippedOtherWeeks}행은 제외됨 (정상)` });
  }

  return { applicable, errors, appliedCount: applicable.length, format: '어드민' };
}

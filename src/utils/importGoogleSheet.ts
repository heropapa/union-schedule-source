/**
 * 구글시트 "출력화면" 탭에서 스케쥴 직접 가져오기.
 *
 * 출력화면 구조 (주차 블록이 세로로 반복):
 *   [X Week]
 *   휴무자 | 8월16일(일) | ... | 8월22일(토)     ← 날짜 헤더
 *   1..11  | 이름들                              ← 그 요일 휴무자
 *   백업   | 백업대상 ...
 *   박건상 | 516A,516B | ...                     ← 백업기사가 그 요일 뛰는 라우트(빈칸=미투입)
 *   백업휴무자
 *   1..5   | 이름들                              ← 백업기사 휴무
 *
 * 유스프에서 보고 있는 주차와 날짜(월/일)가 일치하는 블록만 골라 적용.
 * 시트는 "링크가 있는 모든 사용자 보기" 공유 + 출력화면 탭을 연 상태의
 * 주소(#gid=숫자 포함)를 사용.
 */
import type { ScheduleCell, Worker, CellStatus } from '../types';
import type { ScheduleImportResult, ImportError } from './importScheduleExcel';

/** 구글시트 URL → 시트 ID */
export function extractSheetId(url: string): string | null {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

/** 구글시트 URL → 탭 gid (#gid=... 또는 ?gid=...) */
export function extractGid(url: string): string | null {
  const m = url.match(/[#?&]gid=(\d+)/);
  return m ? m[1] : null;
}

/** 알려진 시트의 출력화면 탭 gid (주소에 #gid가 없을 때 자동 사용) */
const KNOWN_OUTPUT_GIDS: Record<string, string> = {
  // 부산2 실무 스프레드시트 → 출력화면 탭
  '19Tfd6xrl6igHQQL3G7Nj0NdKxHaxTadOUfPxML20oNs': '780158230',
};

/** 주소에서 gid를 찾고, 없으면 알려진 출력화면 탭 gid로 대체 */
export function resolveGid(url: string, sheetId: string): string | null {
  return extractGid(url) ?? KNOWN_OUTPUT_GIDS[sheetId] ?? null;
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
const isNA = (v: string) => v.includes('N/A');

/** '8월 16일 (일)' → { m: 8, d: 16 } */
function parseKDate(v: string): { m: number; d: number } | null {
  const m = trim(v).match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (!m) return null;
  return { m: parseInt(m[1], 10), d: parseInt(m[2], 10) };
}

/** 링크 공유된 시트의 특정 탭(gid) CSV — 원본 그대로(export) */
export async function fetchSheetTabCsv(sheetId: string, gid: string): Promise<string> {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`구글시트를 읽을 수 없습니다 (HTTP ${res.status}). 시트가 "링크가 있는 모든 사용자 보기"로 공유돼 있는지 확인하세요.`);
  }
  const text = await res.text();
  if (text.trimStart().startsWith('<')) {
    throw new Error('구글시트 응답이 CSV가 아닙니다. 공유 설정(링크 보기 허용)을 확인하세요.');
  }
  return text;
}

type DayRec = { name: string; date: string; kind: 'off' | 'work'; routes: string[]; rowNum: number };

/** 출력화면 그리드에서 현재 주차 블록을 찾아 휴무/백업투입 기록 추출 */
function extractWeekRecords(rows: string[][], weekDates: string[]): { recs: DayRec[]; found: boolean } {
  // 현재 주차의 (월,일) 시그니처
  const wantMD = weekDates.map((d) => {
    const [, m, dd] = d.split('-');
    return `${parseInt(m, 10)}-${parseInt(dd, 10)}`;
  });

  for (let hr = 0; hr < rows.length; hr++) {
    const header = rows[hr];
    // 날짜 헤더 행: 한 행에 월/일 셀이 5개 이상
    const dateCols: { col: number; md: string }[] = [];
    header.forEach((c, i) => {
      const kd = parseKDate(c);
      if (kd) dateCols.push({ col: i, md: `${kd.m}-${kd.d}` });
    });
    if (dateCols.length < 5) continue;

    // 이 블록이 현재 주차인지 (첫 날짜가 일요일과 일치 + 과반 일치)
    const matchCnt = dateCols.filter((dc, i) => wantMD[i] === dc.md).length;
    if (dateCols[0].md !== wantMD[0] || matchCnt < 5) continue;

    const labelCol = Math.max(0, dateCols[0].col - 1);
    // 날짜 컬럼 → 실제 yyyy-mm-dd
    const colDate = new Map<number, string>();
    dateCols.forEach((dc, i) => { if (weekDates[i]) colDate.set(dc.col, weekDates[i]); });

    const recs: DayRec[] = [];
    let mode: 'off' | 'backup' | 'backupoff' = 'off';

    for (let r = hr + 1; r < rows.length; r++) {
      const row = rows[r] ?? [];
      // 다음 블록의 날짜 헤더를 만나면 종료
      const nextDates = row.filter((c) => parseKDate(c)).length;
      if (nextDates >= 5) break;

      const label = trim(row[labelCol]);
      if (label === '백업') { mode = 'backup'; continue; }
      if (label === '백업휴무자') { mode = 'backupoff'; continue; }
      if (/week/i.test(label)) continue;

      if (mode === 'backup') {
        // 라벨 = 백업기사 이름, 날짜칸 = 그날 뛰는 라우트
        if (!label || isNA(label)) continue;
        for (const [col, date] of colDate) {
          const v = trim(row[col]);
          if (!v || isNA(v) || v === '백업대상') continue;
          const routes = v.split(',').map((s) => s.trim()).filter(Boolean);
          recs.push({ name: label, date, kind: 'work', routes, rowNum: r + 1 });
        }
      } else {
        // off / backupoff: 날짜칸 = 그날 휴무자 이름
        for (const [col, date] of colDate) {
          const nm = trim(row[col]);
          if (!nm || isNA(nm)) continue;
          recs.push({ name: nm, date, kind: 'off', routes: [], rowNum: r + 1 });
        }
      }
    }
    return { recs, found: true };
  }
  return { recs: [], found: false };
}

/** 추출된 기록 → 셀 + 리포트 (매칭 공통부) */
function buildResult(
  recs: DayRec[],
  workers: Worker[],
): ScheduleImportResult {

  // 이름 매칭 (동명이인은 오류로)
  const byName = new Map<string, Worker[]>();
  for (const w of workers) {
    const l = byName.get(w.name) ?? []; l.push(w); byName.set(w.name, l);
  }

  const work: ScheduleCell[] = [];
  const off: ScheduleCell[] = [];
  const unmatched = new Map<string, number>();   // 이름 → 첫 등장 행
  const dupNames = new Set<string>();

  for (const rec of recs) {
    const cands = byName.get(rec.name);
    if (!cands || cands.length === 0) {
      if (!unmatched.has(rec.name)) unmatched.set(rec.name, rec.rowNum);
      continue;
    }
    if (cands.length > 1) { dupNames.add(rec.name); continue; }
    const w = cands[0];
    const cell: ScheduleCell = {
      workerId: w.id,
      date: rec.date,
      status: (rec.kind === 'off' ? 'off' : 'work') as CellStatus,
      routes: rec.kind === 'off' ? [] : rec.routes,
    };
    (rec.kind === 'off' ? off : work).push(cell);
  }

  const errors: ImportError[] = [];
  for (const [nm, rowNum] of unmatched) {
    errors.push({ row: rowNum, reason: `유스프에 등록되지 않은 인원: "${nm}" — 이 인원 칸은 건너뜀` });
  }
  for (const nm of dupNames) {
    errors.push({ row: 0, reason: `동명이인 "${nm}" — 구분 불가로 건너뜀` });
  }

  // 근무를 먼저, 휴무를 나중에 적용 (같은 사람·날짜가 겹치면 휴무 우선)
  const applicable = [...work, ...off];
  return { applicable, errors, appliedCount: applicable.length, format: '구글시트' };
}

/** 구글시트(출력화면 탭) 링크 → 현재 캠프·주차 셀 + 검증 리포트 */
export async function importFromGoogleSheet(
  sheetId: string,
  gid: string,
  ctx: { campId: string; campName: string; weekDates: string[]; workers: Worker[] },
): Promise<ScheduleImportResult> {
  const csv = await fetchSheetTabCsv(sheetId, gid);
  const grid = parseCsv(csv);
  const { recs, found } = extractWeekRecords(grid, ctx.weekDates);
  if (!found) {
    throw new Error(
      `시트에서 현재 주차(${ctx.weekDates[0]} 시작) 블록을 찾지 못했습니다.\n` +
      `출력화면 탭이 맞는지, 그 주차가 시트에 있는지 확인하세요.`,
    );
  }
  return buildResult(recs, ctx.workers);
}

/**
 * 백업 블록만 붙여넣은 경우 해석:
 *   각 줄 = [백업기사 이름, 일, 월, 화, 수, 목, 금, 토] (탭 구분, 날짜 헤더 없음)
 *   - 라우트가 적힌 칸 → 그 백업기사 출근+배정
 *   - 그 라우트의 원래 주인(고정인원, 라우트 전부 커버 시) → 자동 휴무
 *   - '백업휴무자' 줄 이후의 이름 → 그 백업기사 휴무
 */
function parseBackupOnly(
  grid: string[][],
  ctx: { weekDates: string[]; workers: Worker[] },
): { recs: DayRec[]; notes: ImportError[] } {
  const recs: DayRec[] = [];
  const notes: ImportError[] = [];
  const coveredByDate = new Map<string, Set<string>>();  // date → 커버된 서브라우트
  let mode: 'backup' | 'backupoff' = 'backup';

  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const label = trim(row[0]);
    if (!label && row.every((c) => !trim(c))) continue;
    if (label === '백업' || trim(row[1]) === '백업대상') continue;
    if (label === '백업휴무자') { mode = 'backupoff'; continue; }
    if (label === '휴무자' || parseKDate(label)) continue;   // 실수로 섞인 다른 블록 줄 무시

    for (let d = 0; d < 7; d++) {
      const date = ctx.weekDates[d];
      const v = trim(row[d + 1]);
      if (!v || isNA(v)) continue;
      if (mode === 'backupoff') {
        // 번호 줄: 칸 값 = 휴무자 이름
        recs.push({ name: v, date, kind: 'off', routes: [], rowNum: r + 1 });
      } else {
        if (!label || isNA(label)) continue;
        const routes = v.split(',').map((s) => s.trim()).filter(Boolean);
        recs.push({ name: label, date, kind: 'work', routes, rowNum: r + 1 });
        const set = coveredByDate.get(date) ?? new Set<string>();
        routes.forEach((rt) => set.add(rt));
        coveredByDate.set(date, set);
      }
    }
  }

  // 자동 휴무: 고정인원의 라우트가 그날 백업들로 전부 커버되면 휴무
  const regularNames = new Set(recs.filter((x) => x.kind === 'work').map((x) => x.name));
  for (const [date, covered] of coveredByDate) {
    for (const w of ctx.workers) {
      if (w.role !== 'regular' || w.assignedRoutes.length === 0) continue;
      if (regularNames.has(w.name)) continue;            // 백업 블록에 직접 등장한 이름은 제외
      const hit = w.assignedRoutes.filter((rt) => covered.has(rt));
      if (hit.length === 0) continue;
      if (hit.length === w.assignedRoutes.length) {
        recs.push({ name: w.name, date, kind: 'off', routes: [], rowNum: 0 });
      } else {
        notes.push({
          row: 0,
          reason: `${date.slice(5)} ${w.name}: 라우트 일부(${hit.join(',')})만 백업 커버 — 자동 휴무 안 함, 직접 확인`,
        });
      }
    }
  }

  return { recs, notes };
}

/**
 * 시트에서 복사해 붙여넣은 텍스트(탭 구분) → 현재 캠프·주차 셀 + 검증 리포트.
 * ① 날짜 헤더 포함 전체 블록("휴무자 | 9월 6일 (일) | ...") 또는
 * ② 백업 블록만([백업기사, 일..토 라우트]) 붙여넣기 지원.
 */
export function importFromPastedText(
  text: string,
  ctx: { weekDates: string[]; workers: Worker[] },
): ScheduleImportResult {
  const grid = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.split('\t'));

  // ① 날짜 헤더가 있으면 전체 블록 해석
  const { recs, found } = extractWeekRecords(grid, ctx.weekDates);
  if (found) return buildResult(recs, ctx.workers);

  // ② 날짜 헤더가 없으면 백업 블록만으로 해석 (첫 칸=이름, 이후 7칸=일~토)
  const { recs: brecs, notes } = parseBackupOnly(grid, ctx);
  if (brecs.length === 0) {
    throw new Error(
      `붙여넣은 내용을 해석하지 못했습니다.\n` +
      `- 전체 블록: "휴무자 | 9월 6일 (일) | ..." 날짜 줄부터 복사\n` +
      `- 백업만: 백업기사 이름 줄부터 복사 (이름 + 요일별 라우트, 일~토 순)\n` +
      `그리고 유스프가 맞는 주차 화면인지 확인하세요.`,
    );
  }
  const result = buildResult(brecs, ctx.workers);
  result.errors.push(...notes);
  return result;
}

import * as XLSX from 'xlsx';
import type { Worker, SubRoute } from '../types';

/**
 * 어드민 양식 파싱 결과
 */
export interface ImportRow {
  rowNum: number;         // 엑셀 행 번호 (헤더=1, 데이터=2~)
  date: string;           // 'yyyy-MM-dd'
  campName: string;
  wave: string;
  name: string;
  loginId: string;
  status: string;         // '출근' etc.
  rotations: string[];
  routes: SubRoute[];
}

export interface ImportMatch {
  row: ImportRow;
  worker: Worker;
}

export interface ImportMismatch {
  row: ImportRow;
  reason: string;
}

export interface ImportResult {
  /** 파싱된 전체 행 */
  allRows: ImportRow[];
  /** 매칭된 행 (대입 가능) */
  matched: ImportMatch[];
  /** 불일치 행 */
  mismatched: ImportMismatch[];
  /** 양식에 없는 기존 인원 (해당 날짜에 off 처리 대상) */
  missingWorkers: { worker: Worker; dates: string[] }[];
  /** 파싱된 날짜 범위 */
  dates: string[];
  /** 파싱된 캠프명 */
  campName: string;
  /** 파싱된 웨이브 */
  wave: string;
}

/** Excel 시리얼 → yyyy-MM-dd */
function excelSerialToDate(serial: number): string {
  // Excel epoch: 1899-12-30
  const epoch = new Date(1899, 11, 30);
  const dt = new Date(epoch.getTime() + serial * 24 * 60 * 60 * 1000);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 날짜 문자열 파싱 (다양한 형식 지원) */
function parseDate(val: unknown): string | null {
  if (typeof val === 'number') {
    return excelSerialToDate(val);
  }
  if (typeof val === 'string') {
    // yyyy/mm/dd or yyyy-mm-dd
    const m = val.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (m) {
      return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    }
  }
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return null;
}

/** 엑셀 파일 → ImportRow[] 파싱 */
export function parseAdminExcel(buffer: ArrayBuffer): ImportRow[] {
  const wb = XLSX.read(buffer, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];

  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { header: 1 });
  if (raw.length < 2) return [];

  // 헤더 행에서 컬럼 인덱스 매핑
  const header = (raw[0] as unknown[]).map((v) => String(v ?? '').trim());
  const colIdx = {
    date: header.findIndex((h) => h.includes('업무일')),
    camp: header.findIndex((h) => h.includes('캠프')),
    wave: header.findIndex((h) => h.includes('웨이브')),
    name: header.findIndex((h) => h.includes('이름')),
    loginId: header.findIndex((h) => h.includes('아이디')),
    status: header.findIndex((h) => h.includes('업무상태')),
    rotation: header.findIndex((h) => h.includes('회전')),
    routes: header.findIndex((h) => h.includes('업무라우트') || h.includes('라우트')),
  };

  const rows: ImportRow[] = [];
  for (let i = 1; i < raw.length; i++) {
    const r = raw[i] as unknown[];
    if (!r || r.length === 0) continue;

    const dateVal = colIdx.date >= 0 ? r[colIdx.date] : undefined;
    const date = parseDate(dateVal);
    if (!date) continue; // 날짜 없으면 스킵

    const name = String(r[colIdx.name] ?? '').trim();
    const loginId = String(r[colIdx.loginId] ?? '').trim();
    if (!name && !loginId) continue; // 이름도 아이디도 없으면 스킵

    const campName = colIdx.camp >= 0 ? String(r[colIdx.camp] ?? '').trim() : '';
    const wave = colIdx.wave >= 0 ? String(r[colIdx.wave] ?? '').trim() : '';
    const status = colIdx.status >= 0 ? String(r[colIdx.status] ?? '').trim() : '출근';
    const rotationStr = colIdx.rotation >= 0 ? String(r[colIdx.rotation] ?? '').trim() : '';
    const routeStr = colIdx.routes >= 0 ? String(r[colIdx.routes] ?? '').trim() : '';

    rows.push({
      rowNum: i + 1, // 엑셀 행번호 (1-based, 헤더=1이므로 데이터는 2~)
      date,
      campName,
      wave,
      name,
      loginId,
      status,
      rotations: rotationStr ? rotationStr.split(',').map((s) => s.trim()).filter(Boolean) : [],
      routes: routeStr ? routeStr.split(',').map((s) => s.trim()).filter(Boolean) : [],
    });
  }

  return rows;
}

/** 파싱된 행과 기존 인원 매칭 */
export function matchImportRows(
  rows: ImportRow[],
  workers: Worker[],
  campId: string,
): ImportResult {
  const campWorkers = workers.filter((w) => w.campId === campId);
  const matched: ImportMatch[] = [];
  const mismatched: ImportMismatch[] = [];

  // loginId → Worker 맵
  const byLoginId = new Map<string, Worker>();
  // name → Worker 맵 (loginId 없을 때 폴백)
  const byName = new Map<string, Worker[]>();
  for (const w of campWorkers) {
    if (w.loginId) byLoginId.set(w.loginId.toLowerCase(), w);
    const list = byName.get(w.name) ?? [];
    list.push(w);
    byName.set(w.name, list);
  }

  // 날짜 수집
  const dateSet = new Set<string>();
  // 매칭된 worker+date 조합
  const matchedPairs = new Set<string>();

  const campName = rows[0]?.campName ?? '';
  const wave = rows[0]?.wave ?? '';

  for (const row of rows) {
    dateSet.add(row.date);

    // 1차: loginId로 매칭
    let worker: Worker | undefined;
    if (row.loginId) {
      worker = byLoginId.get(row.loginId.toLowerCase());
    }

    // 2차: 이름으로 매칭 (loginId 매칭 실패 시)
    if (!worker && row.name) {
      const candidates = byName.get(row.name);
      if (candidates && candidates.length === 1) {
        worker = candidates[0];
      } else if (candidates && candidates.length > 1) {
        // 동명이인 → loginId 없이는 구분 불가
        mismatched.push({
          row,
          reason: `동명이인 ${candidates.length}명 — 아이디로 구분 필요`,
        });
        continue;
      }
    }

    if (!worker) {
      mismatched.push({
        row,
        reason: `등록되지 않은 인원`,
      });
      continue;
    }

    matched.push({ row, worker });
    matchedPairs.add(`${worker.id}::${row.date}`);
  }

  const dates = Array.from(dateSet).sort();

  // 양식에 없는 기존 인원 찾기 (해당 날짜 범위에서)
  const missingWorkers: { worker: Worker; dates: string[] }[] = [];
  for (const w of campWorkers) {
    const missingDates = dates.filter((d) => !matchedPairs.has(`${w.id}::${d}`));
    if (missingDates.length > 0) {
      missingWorkers.push({ worker: w, dates: missingDates });
    }
  }

  return {
    allRows: rows,
    matched,
    mismatched,
    missingWorkers,
    dates,
    campName,
    wave,
  };
}

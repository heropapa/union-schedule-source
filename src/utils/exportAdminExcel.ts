import * as XLSX from 'xlsx';
import type { Worker, SubRoute } from '../types';

/**
 * 어드민 전산 업로드용 엑셀 양식
 * 컬럼: 업무일 | 벤더명 | 사업자등록번호 | 캠프명 | 웨이브 | 이름 | 아이디 | 업무상태 | 회전 | 업무라우트
 * 한 행 = 한 사람 × 한 날짜
 */

export interface AdminExportConfig {
  vendorName: string;       // 벤더명 (예: "(주)넥스트 유니온/NEXTU")
  businessNumber: string;   // 사업자등록번호 (예: "5258603344")
  campName: string;         // 캠프명 (예: "통영1")
  wave: string;             // 웨이브 (예: "WAVE1")
}

interface AdminExportOptions {
  config: AdminExportConfig;
  weekDates: string[];      // ['2026-03-08', '2026-03-09', ...]
  regulars: Worker[];
  backups: Worker[];
  getEffectiveCell: (workerId: string, date: string) => { status: string; routes: SubRoute[] } | undefined;
}

/** yyyy-mm-dd → Excel 시리얼 넘버 (쿠팡 어드민 요구 형식) */
function dateToExcelSerial(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  // Excel epoch: 1899-12-30
  const epoch = new Date(1899, 11, 30);
  const diff = dt.getTime() - epoch.getTime();
  return Math.round(diff / (24 * 60 * 60 * 1000));
}

export function exportAdminExcel(opts: AdminExportOptions) {
  const { config, weekDates, regulars, backups, getEffectiveCell } = opts;
  const allWorkers = [...regulars, ...backups];

  const wb = XLSX.utils.book_new();
  const rows: (string | number)[][] = [];

  // 헤더
  rows.push(['업무일', '벤더명', '사업자등록번호', '캠프명', '웨이브', '이름', '아이디', '업무상태', '회전', '업무라우트']);

  // 날짜별 × 인원별 행 생성
  for (const date of weekDates) {
    const serial = dateToExcelSerial(date);

    for (const w of allWorkers) {
      if (!w.loginId) continue; // 아이디 없는 미정 인원 제외

      const cell = getEffectiveCell(w.id, date);
      const isWorking = cell && (cell.status === 'work' || cell.status === 'custom');

      // 휴무일은 행에 포함하지 않음
      if (!isWorking) continue;

      const status = isWorking ? '출근' : '휴무';
      const routeStr = isWorking ? cell!.routes.join(',') : '';
      const rotationStr = isWorking ? (w.rotations ?? []).join(',') : '';

      rows.push([
        serial,                  // 업무일 (Excel 시리얼 넘버)
        config.vendorName,       // 벤더명
        config.businessNumber,   // 사업자등록번호
        config.campName,         // 캠프명
        config.wave,             // 웨이브
        w.name,                  // 이름
        w.loginId,               // 아이디
        status,                  // 업무상태
        rotationStr,             // 회전
        routeStr,                // 업무라우트
      ]);
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);

  // 날짜 셀에 yyyy/mm/dd 서식 적용 (쿠팡 형식)
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
  for (let r = 1; r <= range.e.r; r++) {
    const addr = XLSX.utils.encode_cell({ r, c: 0 });
    if (ws[addr] && ws[addr].t === 'n') {
      ws[addr].z = 'yyyy/mm/dd';
    }
  }

  // 열 너비
  ws['!cols'] = [
    { wch: 12 },  // 업무일
    { wch: 26 },  // 벤더명
    { wch: 14 },  // 사업자등록번호
    { wch: 10 },  // 캠프명
    { wch: 8 },   // 웨이브
    { wch: 10 },  // 이름
    { wch: 16 },  // 아이디
    { wch: 8 },   // 업무상태
    { wch: 16 },  // 회전
    { wch: 28 },  // 업무라우트
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Sheet0');

  // 파일명: 어드민양식_캠프명(웨이브)_시작날짜.xlsx
  const startDate = weekDates[0] ?? new Date().toISOString().slice(0, 10);
  const fileName = `어드민양식_${config.campName}(${config.wave})_${startDate}.xlsx`;
  XLSX.writeFile(wb, fileName);
}

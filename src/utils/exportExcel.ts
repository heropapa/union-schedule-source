import * as XLSX from 'xlsx';
import type { Worker, SubRoute } from '../types';
import { DAY_LABELS } from '../types';

interface ExportOptions {
  campName: string;
  weekLabel: string;
  weekDates: string[];
  regulars: Worker[];
  backups: Worker[];
  getEffectiveCell: (workerId: string, date: string) => { status: string; routes: SubRoute[] } | undefined;
  getUncoveredRoutes: (date: string) => SubRoute[];
  getDuplicateRoutes: (date: string) => Array<{ route: SubRoute; workers: string[] }>;
}

/** 셀 상태를 텍스트로 변환 */
function cellText(
  cell: { status: string; routes: SubRoute[] } | undefined,
  worker: Worker,
): string {
  if (!cell) return '';
  switch (cell.status) {
    case 'work':
      // 백업: 배정 라우트 표시 / 고정: 자기 라우트 표시
      if (worker.role === 'backup') {
        return cell.routes.length > 0 ? cell.routes.join(',') : '근';
      }
      return cell.routes.join(',') || '근';
    case 'off': return '휴';
    case 'custom': return cell.routes.join(',') || '직접';
    case 'empty': return '';
    default: return '';
  }
}

/** 셀 배경색 */
function cellFill(status: string | undefined): { fgColor?: { rgb: string } } | undefined {
  switch (status) {
    case 'work': return { fgColor: { rgb: 'D5E8D4' } };  // 연두
    case 'off': return { fgColor: { rgb: 'F8CECC' } };    // 연빨강
    case 'custom': return { fgColor: { rgb: 'DAE8FC' } }; // 연파랑
    default: return undefined;
  }
}

export function exportScheduleExcel(opts: ExportOptions) {
  const {
    campName, weekLabel, weekDates,
    regulars, backups,
    getEffectiveCell, getUncoveredRoutes, getDuplicateRoutes,
  } = opts;

  const wb = XLSX.utils.book_new();
  const rows: (string | number)[][] = [];

  // 헤더 행
  const dayHeaders = weekDates.map((d, i) => `${DAY_LABELS[i]}(${d.slice(5)})`);
  rows.push(['구분', '이름', '아이디', '담당 라우트', ...dayHeaders]);

  // 고정 기사
  for (const w of regulars) {
    const dayCells = weekDates.map((d) => {
      const cell = getEffectiveCell(w.id, d);
      return cellText(cell, w);
    });
    rows.push(['고정', w.name, w.loginId || '', w.assignedRoutes.join(', '), ...dayCells]);
  }

  // 구분선
  rows.push(['─ 백업 인원 ─', '', '', '', ...weekDates.map(() => '')]);

  // 백업 기사
  for (const w of backups) {
    const dayCells = weekDates.map((d) => {
      const cell = getEffectiveCell(w.id, d);
      return cellText(cell, w);
    });
    rows.push(['백업', w.name, w.loginId || '', '-', ...dayCells]);
  }

  // 미커버 라우트
  const hasUncovered = weekDates.some((d) => getUncoveredRoutes(d).length > 0);
  if (hasUncovered) {
    rows.push([]);
    const uncoveredRow = ['미커버', '', '', ''];
    for (const d of weekDates) {
      uncoveredRow.push(getUncoveredRoutes(d).join(', '));
    }
    rows.push(uncoveredRow);
  }

  // 중복 배정
  const hasDupes = weekDates.some((d) => getDuplicateRoutes(d).length > 0);
  if (hasDupes) {
    const dupeRow: string[] = ['중복', '', '', ''];
    for (const d of weekDates) {
      const dupes = getDuplicateRoutes(d);
      dupeRow.push(dupes.map((dp) => `${dp.route}(${dp.workers.join('/')})`).join(', '));
    }
    rows.push(dupeRow);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);

  // 열 너비 설정
  ws['!cols'] = [
    { wch: 6 },   // 구분
    { wch: 8 },   // 이름
    { wch: 14 },  // 아이디
    { wch: 22 },  // 담당 라우트
    ...weekDates.map(() => ({ wch: 14 })), // 요일
  ];

  // 스타일 적용 (셀 배경색)
  const headerRowIdx = 0;
  const totalCols = 4 + weekDates.length;

  // 헤더 스타일
  for (let c = 0; c < totalCols; c++) {
    const addr = XLSX.utils.encode_cell({ r: headerRowIdx, c });
    if (ws[addr]) {
      ws[addr].s = {
        fill: { fgColor: { rgb: '4472C4' } },
        font: { bold: true, color: { rgb: 'FFFFFF' } },
        alignment: { horizontal: 'center' },
        border: thinBorder(),
      };
    }
  }

  // 데이터 행 스타일
  let rowIdx = 1;
  const allWorkers = [...regulars, ...backups];
  for (const w of regulars) {
    styleDataRow(ws, rowIdx, weekDates, w, getEffectiveCell, totalCols);
    rowIdx++;
  }
  rowIdx++; // 구분선
  for (const w of backups) {
    styleDataRow(ws, rowIdx, weekDates, w, getEffectiveCell, totalCols);
    rowIdx++;
  }

  const sheetName = `${campName}_${weekDates[0].slice(5)}`;
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));

  const fileName = `스케줄_${campName}_${weekDates[0]}.xlsx`;
  XLSX.writeFile(wb, fileName);
}

function styleDataRow(
  ws: XLSX.WorkSheet,
  rowIdx: number,
  weekDates: string[],
  worker: Worker,
  getEffectiveCell: ExportOptions['getEffectiveCell'],
  totalCols: number,
) {
  // 고정 컬럼 (구분, 이름, 아이디, 라우트) 스타일
  for (let c = 0; c < 4; c++) {
    const addr = XLSX.utils.encode_cell({ r: rowIdx, c });
    if (ws[addr]) {
      ws[addr].s = {
        alignment: { horizontal: c === 0 ? 'center' : 'left' },
        border: thinBorder(),
      };
    }
  }

  // 요일 셀 스타일
  for (let i = 0; i < weekDates.length; i++) {
    const c = 4 + i;
    const addr = XLSX.utils.encode_cell({ r: rowIdx, c });
    const cell = getEffectiveCell(worker.id, weekDates[i]);
    const fill = cellFill(cell?.status);
    if (ws[addr]) {
      ws[addr].s = {
        alignment: { horizontal: 'center' },
        border: thinBorder(),
        ...(fill ? { fill } : {}),
      };
    }
  }
}

function thinBorder() {
  const side = { style: 'thin', color: { rgb: 'B0B0B0' } };
  return { top: side, bottom: side, left: side, right: side };
}

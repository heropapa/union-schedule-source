# 유스프 1.0 (유니온스케쥴프로그램)

유니온물류 캠프 스케쥴 관리 웹앱. 9명 캠프 관리자 + admin 1명이 캠프별
주간 스케쥴 짜고 게시판으로 발행하는 도구.

- **이름 유래**: **유**니온**스**케쥴**프**로그램 → 유스프 1.0 (확정 2026-05-27)
- **로컬 경로**: `C:\Users\heropapa\Documents\my_automation\union-schedule-source\`
  (my_automation 우산 폴더 안 — 정산/스케쥴 데이터와 같은 위치)
- **소스 repo**: https://github.com/heropapa/union-schedule-source (이 repo)
- **배포 repo**: https://github.com/heropapa/union-schedule-test1 (GitHub Pages용 빌드 산출물)
- **배포 URL**: https://heropapa.github.io/union-schedule-test1/

## 기술 스택

- React 19 + Vite + TypeScript + Zustand
- Supabase (Auth + PostgreSQL + RLS)
- 배포: GitHub Pages (`union-schedule-test1` repo)

## 로컬 개발

```bash
# 의존성
npm install

# .env 생성 (한 번만)
echo "VITE_SUPABASE_URL=https://<your-project>.supabase.co" > .env
echo "VITE_SUPABASE_ANON_KEY=<anon-key>" >> .env

# 개발 서버
npm run dev

# 빌드
npm run build

# 타입 체크
npx tsc -p tsconfig.app.json

# Lint
npx eslint .
```

## 디렉토리 구조

```
src/
├── App.tsx                    # 라우팅 (#/board → BoardPage2, 그 외 → 메인)
├── lib/
│   ├── supabase.ts            # Supabase 클라이언트 + toEmail/toDisplayName
│   └── db.ts                  # DB CRUD + acquireLock/heartbeatLock/releaseLock
├── store/
│   ├── useAuthStore.ts        # 인증 + canEditCamp (현재 미사용 — Issue #4)
│   ├── useWorkerStore.ts      # 캠프/기사/라우트
│   ├── useScheduleStore.ts    # 셀 데이터
│   └── useHistoryStore.ts     # undo/redo
├── components/
│   ├── Auth/LoginPage.tsx     # 로그인 (signup은 admin 대시보드)
│   ├── Sidebar/Sidebar.tsx    # 캠프/기사/권한/게시 토글
│   ├── Calendar/ScheduleCalendar.tsx  # 메인 편집 + 캠프 잠금
│   └── Board/BoardPage2.tsx   # /board 익명 공개 게시판
├── types/index.ts             # Worker, Camp, ScheduleCell, CampLock, ...
└── utils/                     # exportExcel, importAdminExcel 등

supabase/
└── rls-public-board.sql       # 익명 게시판용 RLS 정책 (배포 전 적용 필요)
```

## DB 스키마 (Supabase)

| 테이블 | 역할 |
|---|---|
| `profiles` | 사용자 + role (admin/viewer) |
| `camps` | 캠프 정의 + `published` (게시 여부) |
| `workers` | 기사 (camp_id, role=regular/backup) |
| `routes` | 캠프별 라우트 |
| `schedule_cells` | 주간 셀 (worker_id + date) |
| `camp_permissions` | viewer 캠프별 편집 권한 |
| `camp_locks` | 캠프 잠금 (heartbeat 기반, 45s 타임아웃) |

## 2026-05-27 작업 (Top 3 Critical Fix)

| Commit | 내용 |
|---|---|
| `1bcf939` | **fix(lock)**: 캠프 잠금 wire-up. acquireLock/heartbeat(20s)/release를 ScheduleCalendar에 연결. blocked 시 30s 재시도 + 배너 UI + canEdit 가드 |
| `0128ec9` | **fix(auth)**: LoginPage의 dead signup 모드 제거 (-95줄). admin이 Supabase 대시보드에서 직접 계정 생성하는 워크플로우 유지 |
| `9853972` | **fix(board)**: BoardPage2의 ATONE_PW='150527' 평문 하드코딩 제거. anon key + RLS로 전환. `supabase/rls-public-board.sql` 추가. BoardPage.tsx(구버전) 삭제 |

## 2026-05-28 작업 (v1.0 baseline cleanup, v1.1 진입 직전)

| Commit | 내용 |
|---|---|
| `49b5bf0` | **chore**: tracked 잡파일 제거 (`_.zip`, `src.zip`, `_preview_dist/`, `schedule-v2-*.xlsx`). `.gitignore` 확장 |
| `c99c9cf` | **fix(ts)**: typecheck 에러 6건 해결 (미사용 import/var, `header:1` sheet_to_json generic 타입) |
| `b26e970` | **fix(lint)**: `any` 9건 → 구체 row 타입(`CampRow`/`WorkerRow`/...) + regex useless escape |
| `2bb9a92` | **fix(react)**: Sidebar.useDragReorder ref-during-render → useEffect. ScheduleCalendar handleRowDrop useCallback wrap + workerStore deps |
| `145359a` | **fix(auth)**: Issue #4 권한 게이팅 wire-up. canEdit = lock∧권한, lock acquire 자체에 권한 게이트, Sidebar mutation들에 `withCampPermission()` |
| `bb92616` | **fix(react, perf)**: Issue #4 잔여 gaps + Issue #5 closeout. drop/autoFill 게이트, lock effect dep 좁힘, Sidebar 6 deps warning 0건, supabase/db static 통일, vite manualChunks + xlsx lazy. 첫 화면 768→478 KB. |

## Supabase 측 조치 (배포 전 필수)

- SQL Editor → `supabase/rls-public-board.sql` 전체 실행 (게시판 RLS)
- Authentication → Users → `atone@schedule.local` 삭제 권장 (anon key 전환으로 더 이상 필요 없음)

## 알려진 잔여 cleanup

(2026-05-28 `bb92616` 에서 일괄 해소 — Sidebar deps 6건, supabase/db mixed import,
manualChunks, xlsx lazy. 현재 typecheck/lint/build 경고 0건.)

## 다음 단계: v1.1 (대대적 기능 추가)

v1.0은 baseline cleanup 완료. v1.1 스펙은 사용자와 별도 논의 후 결정.

논의 시작점 (memory `project_schedule_redesign.md` 기준):
- 게시 기능 확장 (현재: 캠프 단위 published 토글 / 다음: 주간/일간 단위?)
- 캠프 잠금 정책 (현재: 단일 사용자 / 다음: read-only viewer 다중 접속?)
- 캠프 메타 관리 분리 (현재: Sidebar 인라인 / 다음: 별도 admin 화면?)
- 모바일 뷰
- 알림/공지사항

## 9명 사용자 정보

관리자 9명: 김봉상, 백승엽, 문민중, 정인호, 조용환, 이정길, 전용호, 최아라, 임지현 + admin 1명. 비밀번호 통일 `123456` (Supabase 최소 6자 요구).

## 지원 연락처

문의/권한 요청: 임지현 010-3478-4253 (LoginPage 하단에 표시)

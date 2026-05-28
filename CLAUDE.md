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

## Supabase 측 조치 (배포 전 필수)

- SQL Editor → `supabase/rls-public-board.sql` 전체 실행 (게시판 RLS)
- Authentication → Users → `atone@schedule.local` 삭제 권장 (anon key 전환으로 더 이상 필요 없음)

## 알려진 잔여 cleanup (위험도 낮음, 일괄 처리 가능)

### React deps warnings (Sidebar.tsx 6건)
deps 누락이지만 무차별 추가하면 useEffect 재실행 빈도가 의도와 달라질 수 있어 보수적으로 남김:
- `regulars`/`backups` conditional → useMemo wrap 필요 (L182, L183)
- editingCamp / editingWorker / editingSubRoutes / store deps (L196, L212, L339, L346)

각각 effect 의도를 한 번씩 확인하고 deps 추가 vs `// eslint-disable-next-line react-hooks/exhaustive-deps` 결정 필요.

### 빌드 경고
- `supabase.ts` / `db.ts`가 dynamic+static 동시 import → chunk 분할 안 됨
- bundle 768KB → 500KB 임계 초과. manualChunks 또는 라우트 단위 lazy load 검토

## 9명 사용자 정보

관리자 9명: 김봉상, 백승엽, 문민중, 정인호, 조용환, 이정길, 전용호, 최아라, 임지현 + admin 1명. 비밀번호 통일 `123456` (Supabase 최소 6자 요구).

## 지원 연락처

문의/권한 요청: 임지현 010-3478-4253 (LoginPage 하단에 표시)

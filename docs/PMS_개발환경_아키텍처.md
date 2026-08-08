# PMS 개발환경 아키텍처

> **보관 문서:** 이 문서는 Firebase 전환 이전의 Vercel/Supabase 검토안입니다.
> 현재 구현 기준은 `docs/PMS_캘린더기반_재개발계획서.md`입니다 — 인프라는 Vercel + Supabase로 되돌아왔지만 스택 세부 사항(ORM=Prisma, 인증=Auth.js)이 다릅니다.

> 프로젝트: EPMS 프로젝트관리 시스템(PMS)  
> 문서 버전: v1.0  
> 작성일: 2026-07-31  
> 대상 인프라: Vercel Web Hosting + Supabase Hosted Platform

---

## 1. 설계 결론

PMS는 다음 3개 환경을 분리한다.

| 환경 | 웹 실행 | Supabase | 목적 |
|---|---|---|---|
| 로컬 | 개발자 PC의 Next.js 개발 서버 | Supabase CLI 로컬 스택 | 기능 개발, 마이그레이션, 단위·통합 테스트 |
| 원격 개발·검증 | Vercel Preview/전용 Staging | 별도 Supabase 개발 프로젝트 | 통합 테스트, 사용자 검수, 배포 리허설 |
| 운영 | Vercel Production | 별도 Supabase 운영 프로젝트 | 실제 서비스 |

핵심 원칙은 다음과 같다.

1. 로컬·원격 개발·운영 데이터베이스를 물리적으로 분리한다.
2. 데이터베이스 스키마는 Supabase Dashboard가 아니라 Git의 SQL 마이그레이션을 기준으로 관리한다.
3. 브라우저에는 Supabase 공개용 키만 제공하고 `service_role` 및 DB 접속 문자열은 절대 노출하지 않는다.
4. 사용자 범위 데이터는 Supabase Auth와 Row Level Security(RLS)로 보호한다.
5. 관리자 작업, 다중 테이블 트랜잭션, 보고서 생성은 Vercel 서버 계층에서 처리한다.
6. Vercel Preview가 운영 Supabase에 연결되는 구성을 금지한다.
7. 운영 마이그레이션과 배포는 자동 실행만으로 끝내지 않고 승인 단계를 둔다.

## 2. 전체 구성

```text
[사용자 브라우저]
       |
       | HTTPS
       v
[Vercel - Next.js]
  ├─ 정적 UI / Server Components
  ├─ Route Handlers / Server Actions
  ├─ 인증 세션 검증
  ├─ 관리자·보고서·트랜잭션 로직
  └─ 관측·오류 처리
       |
       | Supabase JS / HTTPS Data API
       | 필요 시 Transaction Pooler
       v
[Supabase Hosted]
  ├─ Auth
  ├─ PostgreSQL
  ├─ Row Level Security
  ├─ Storage
  ├─ Realtime(선택)
  └─ Logs / Backups
```

### 2.1 데이터 접근 경로

| 업무 | 권장 경로 | 이유 |
|---|---|---|
| 로그인·로그아웃·세션 | 브라우저 ↔ Supabase Auth | 표준 인증 흐름 활용 |
| 본인 권한 내 조회 | 브라우저/서버 ↔ Supabase Data API + RLS | 연결 풀 부담 없이 안전하게 조회 |
| 주간보고·이슈 등 일반 CRUD | 로그인 사용자 JWT + RLS | 사용자·프로젝트 권한을 DB에서 강제 |
| 관리자 사용자 승인·역할 변경 | 브라우저 → Vercel 서버 → Supabase Admin | 서비스 키를 서버에만 보관 |
| 여러 테이블을 함께 변경 | Vercel 서버 → DB 함수(RPC) 또는 트랜잭션 | 부분 저장 방지 |
| PDF·Excel 보고서 | Vercel 서버 | 권한 확인, 생성 이력, 파일 응답 제어 |
| 감사 로그 | DB 트리거 + 서버 업무 이벤트 | 누락·위변조 위험 감소 |

## 3. 권장 애플리케이션 구조

Vercel 배포와 서버 기능을 함께 사용하기 위해 Next.js App Router + TypeScript를 기본안으로 한다. 실제 버전은 착수 시점의 안정 버전으로 고정한다.

```text
epms/
  apps/
    web/
      app/                       # 라우트와 레이아웃
        (auth)/                  # 로그인·가입·비밀번호 초기화
        (workspace)/             # 인증 후 업무 화면
        api/                     # Route Handlers
      features/                  # 업무 기능별 UI·훅·검증
      components/                # 공통 UI
      lib/
        supabase/
          browser.ts             # 공개 키 기반 브라우저 클라이언트
          server.ts              # 쿠키/JWT 기반 서버 클라이언트
          admin.ts               # service_role, 서버 전용
        auth/
        validation/
      middleware.ts              # 세션 갱신·보호 라우트
  packages/
    ui/                          # 디자인 토큰·공통 컴포넌트
    domain/                      # 공통 타입·업무 규칙
    config/                      # lint·typescript 공통 설정
  supabase/
    config.toml                  # 로컬 Supabase 설정
    migrations/                  # 스키마 변경의 단일 기준
    seed.sql                     # 비식별 로컬·개발 샘플 데이터
    tests/                       # RLS·DB 함수 테스트
    functions/                   # Supabase Edge Function이 필요한 경우만
  scripts/
    verify-env.mjs
    verify-migrations.mjs
  docs/
```

화면 컴포넌트에 API 호출, 권한 판정, 모달 상태, 업무 계산을 집중시키지 않는다. 화면은 조합을 담당하고 데이터 접근·업무 규칙·검증은 기능 모듈과 서버 계층으로 분리한다.

## 4. 로컬 개발환경

### 4.1 필수 도구

- Git
- 현재 LTS Node.js 및 프로젝트에서 고정한 패키지 매니저
- Docker Desktop 또는 Supabase CLI가 지원하는 Docker 호환 런타임
- Supabase CLI
- Vercel CLI
- VS Code 또는 동급 IDE

Supabase 로컬 스택은 개발 전용이다. TLS, 운영 수준 속도 제한, 운영 보안 설정을 전제로 하지 않으므로 외부 네트워크에 공개하지 않는다.

### 4.2 로컬 서비스

```text
브라우저
  └─ http://localhost:3000          Next.js

Supabase CLI 로컬 스택
  ├─ API/Auth/REST                  config.toml 기준
  ├─ PostgreSQL                    config.toml 기준
  ├─ Studio                        config.toml 기준
  ├─ Inbucket                      개발용 이메일 확인
  └─ Storage                       로컬 파일 API
```

포트 번호를 문서에 중복 고정하지 않고 `supabase/config.toml`을 단일 기준으로 사용한다. 개발 서버와 충돌하지 않는지 CI와 온보딩 스크립트에서 확인한다.

### 4.3 로컬 환경변수

`apps/web/.env.local`은 Git에 커밋하지 않는다.

```dotenv
# 브라우저에서 사용 가능
NEXT_PUBLIC_APP_ENV=local
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:<local-api-port>
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<local-publishable-key>

# 서버 전용 — NEXT_PUBLIC_ 접두사 금지
SUPABASE_SERVICE_ROLE_KEY=<local-service-role-key>
SUPABASE_DB_URL=<local-db-url>
```

저장소에는 키 이름만 포함한 `.env.example`을 둔다. 애플리케이션 시작 시 필수 환경변수와 환경 조합을 검증한다.

### 4.4 로컬 데이터베이스 흐름

```text
요구사항/ERD 변경
  → SQL migration 작성
  → supabase db reset
  → seed.sql 적용
  → RLS/DB 테스트
  → TypeScript DB 타입 생성
  → 애플리케이션 테스트
  → migration + 타입 + 코드 함께 커밋
```

권장 명령 흐름:

```powershell
supabase start
supabase migration new <change_name>
supabase db reset
supabase gen types typescript --local > apps/web/lib/database.types.ts
npm.cmd run test
```

`db reset`은 로컬 DB를 삭제하고 마이그레이션과 seed를 다시 적용한다. 운영 또는 공유 개발 DB를 대상으로 실행하지 않는다.

### 4.5 로컬 데이터

- 실제 운영 개인정보를 내려받지 않는다.
- `seed.sql`에는 한국형이지만 가상의 프로젝트·이름·업무 데이터를 사용한다.
- 관리자, PM/PMO, 사용자, 게스트 계정을 각각 준비한다.
- 프로젝트 멤버십, 영역 배정, RLS 허용·차단 시나리오를 재현한다.
- 날짜 의존 테스트는 고정 기준일을 사용한다.

## 5. 원격 개발·검증환경

### 5.1 물리 구성

```text
[Git develop/staging branch]
       |
       +──> [Vercel Preview 또는 Custom Staging]
       |       └─ staging 전용 환경변수
       |
       └──> [Supabase epms-staging]
               ├─ staging Auth
               ├─ staging PostgreSQL
               └─ staging Storage
```

원격 개발환경은 운영 프로젝트와 별개의 Supabase 프로젝트를 사용한다. 개발·검수 계정, URL, Storage 버킷, Auth 리디렉션도 운영과 분리한다.

### 5.2 Vercel 환경 매핑

| Git 기준 | Vercel 환경 | Supabase 대상 | 용도 |
|---|---|---|---|
| 로컬 작업 | Development | Supabase CLI Local | 개인 개발 |
| `feature/*` PR | Preview | Supabase Preview Branch 또는 staging | PR 검증 |
| `develop`/`staging` | Preview 브랜치 고정 또는 Custom Staging | `epms-staging` | 통합·UAT |
| `main` | Production | `epms-production` | 운영 |

Vercel Pro를 사용하는 경우 `staging` Custom Environment와 브랜치 추적을 권장한다. 그 외 플랜에서는 Preview 환경변수를 `staging` 브랜치에 한정한다. 일반 PR이 공유 staging DB를 사용할 경우 테스트 데이터 충돌 가능성을 별도 관리한다.

Supabase Branching을 사용할 수 있으면 PR별 임시 DB 브랜치를 생성해 스키마와 테스트 데이터를 격리한다. 사용할 수 없으면 feature PR은 로컬 DB 테스트를 필수로 하고 원격 통합 검증은 공용 staging에서 순차 수행한다.

### 5.3 원격 환경변수

| 변수 | Development | Preview/Staging | Production | 노출 범위 |
|---|---|---|---|---|
| `NEXT_PUBLIC_APP_ENV` | `local` | `staging` | `production` | 브라우저 |
| `NEXT_PUBLIC_SUPABASE_URL` | Local URL | staging URL | production URL | 브라우저 |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Local 공개 키 | staging 공개 키 | production 공개 키 | 브라우저 |
| `SUPABASE_SERVICE_ROLE_KEY` | Local 키 | staging 비밀 키 | production 비밀 키 | 서버 전용 |
| `SUPABASE_DB_URL` | Local DB | staging pooler | production pooler | 서버 전용 |
| `SUPABASE_DIRECT_URL` | Local DB | staging direct | production direct | 마이그레이션 전용 |
| `APP_BASE_URL` | localhost | Preview/Staging URL | 운영 도메인 | 서버 전용 |

환경변수 변경은 기존 배포에 자동 적용되지 않으므로 새 배포가 필요하다. Preview와 Production 값을 각각 검증하며 운영 키를 Preview에 복사하지 않는다.

### 5.4 Auth URL 설정

- 로컬: `http://localhost:3000/**`
- staging: 고정 staging 도메인
- Preview: 필요한 Preview URL 패턴만 허용
- 운영: 실제 서비스 도메인만 허용

가입 확인, 비밀번호 초기화, OAuth/SSO 콜백 URL을 환경별로 분리한다. 임의 Origin이나 광범위한 와일드카드는 운영에서 허용하지 않는다.

## 6. 운영환경

```text
[Git main]
    |
    +── 승인된 DB migration ──> [Supabase epms-production]
    |
    └── 승인된 Web build ─────> [Vercel Production]
```

운영환경은 다음을 보장한다.

- Supabase 운영 프로젝트는 개발자가 일상적으로 `link`하는 기본 대상이 아니다.
- 운영 데이터에 seed를 적용하지 않는다.
- Dashboard에서 직접 스키마를 변경하지 않는다.
- 운영 마이그레이션 전 백업·영향도·롤백 또는 전진 수정 방안을 확인한다.
- Vercel Production 배포에는 운영 Supabase 공개 키와 서버 비밀 키만 연결한다.
- 운영 도메인, Supabase Auth Site URL, 리디렉션 URL을 일치시킨다.

## 7. Supabase 데이터베이스 보안

### 7.1 인증·프로필 구조

```text
auth.users
   1 ── 1 public.user_profile
   1 ── N public.project_member
                 N ── 1 public.project
```

`auth.users`는 인증 주체로만 사용한다. 소속사, 직책, 직급, 상태, 표시 이름 등 업무 프로필은 `public.user_profile`에 저장한다.

### 7.2 RLS 정책

모든 사용자 데이터 테이블에서 RLS를 활성화한다.

```sql
alter table public.project enable row level security;
alter table public.project_member enable row level security;
alter table public.weekly_report enable row level security;
alter table public.weekly_progress enable row level security;
alter table public.issue enable row level security;
alter table public.staff_change enable row level security;
```

정책 기준:

- 사용자는 멤버로 배정된 프로젝트만 조회한다.
- 일반 사용자는 배정된 영역 또는 본인이 작성한 데이터만 수정한다.
- PM/PMO는 담당 프로젝트의 업무 데이터를 관리한다.
- 관리자는 승인된 관리 API를 통해서만 전역 작업을 수행한다.
- 게스트는 조회만 허용한다.
- `anon` 역할에는 업무 테이블 접근 권한을 부여하지 않는다.

RLS에서 사용하는 `project_id`, `user_id`, `area_code`, `status`, `week_id`와 모든 외래키에 필요한 인덱스를 둔다. `auth.uid()` 등 고정 함수는 `(select auth.uid())` 형태를 사용해 행마다 반복 평가되지 않게 한다.

복잡한 프로젝트 권한 검사는 `private` 스키마의 제한된 `security definer` 함수로 캡슐화할 수 있다. 함수 내부에서 호출자의 `auth.uid()`를 검증하고 `search_path`를 빈 값으로 고정하며 불필요한 실행 권한을 회수한다.

### 7.3 서비스 키 사용

`SUPABASE_SERVICE_ROLE_KEY`는 RLS를 우회하므로 다음 작업으로 제한한다.

- 가입 승인과 사용자 상태 변경
- 관리자 역할 부여·회수
- 서버 배치·보고서 생성에 필요한 명시적 관리자 작업
- 데이터 이관 스크립트

일반 사용자 CRUD에 서비스 키를 사용하지 않는다. 서버에서도 사용자 JWT 기반 Supabase 클라이언트를 우선 사용해 RLS를 유지한다.

### 7.4 Storage

```text
project-files/
  <project_id>/
    issues/<issue_id>/...
    reports/<week_id>/...
```

- 버킷은 기본 비공개로 운영한다.
- Storage RLS는 `project_member`를 기준으로 읽기·쓰기 권한을 확인한다.
- 파일 크기, MIME, 확장자, 업로더, 체크섬을 검증한다.
- 다운로드는 짧은 만료시간의 Signed URL을 사용한다.
- 파일 메타데이터와 업무 엔터티 연결을 DB에 기록한다.

## 8. DB 연결 전략

### 8.1 런타임

- 우선 방식: Supabase JS/Data API. Vercel 함수가 DB 연결을 직접 장시간 유지하지 않는다.
- SQL 드라이버나 ORM이 꼭 필요한 서버 기능: Supabase Transaction Pooler 사용.
- 풀 객체는 요청마다 만들지 않고 모듈 전역에서 재사용한다.
- Transaction Pooler에서는 드라이버의 named prepared statement 사용 여부를 확인한다.
- 함수별 최대 연결 수를 작게 유지하고 Vercel 동시 실행 수 증가를 고려한다.

### 8.2 마이그레이션

- 스키마 마이그레이션은 direct connection 또는 Supabase CLI `db push`를 사용한다.
- 마이그레이션 연결 문자열을 애플리케이션 런타임에 노출하지 않는다.
- CI에서 적용 전 `supabase db push --dry-run`과 마이그레이션 이력 비교를 수행한다.
- 운영 중 대규모 인덱스 추가는 잠금 영향을 검토하고 필요하면 `create index concurrently`를 별도 마이그레이션으로 수행한다.

### 8.3 스키마 기본 규칙

- 테이블·컬럼·인덱스는 영문 소문자 `snake_case`를 사용한다.
- 기본키는 `bigint generated always as identity` 또는 외부 노출이 필요한 경우 시간 정렬 UUID를 검토한다.
- 모든 외래키 컬럼을 인덱싱한다.
- 시간은 `timestamptz`, 문자열은 특별한 길이 제한이 없으면 `text`를 사용한다.
- 공정율은 범위 제약을 적용한 `numeric`, 인원수는 음수 금지 `integer`를 사용한다.
- 업무 데이터는 물리 삭제보다 상태·삭제일을 사용하는 소프트 삭제를 기본으로 한다.
- `created_at`, `created_by`, `updated_at`, `updated_by`, `version`을 표준 감사 필드로 둔다.

## 9. Git·CI/CD 흐름

### 9.1 브랜치 전략

```text
feature/* ── PR ──> develop/staging ── 승인 ──> main
   |                    |                          |
Local DB           Staging DB                Production DB
Vercel Preview     Vercel Staging            Vercel Production
```

소규모 팀에서는 `feature/* → main`의 단순 흐름도 가능하지만 원격 개발 DB를 별도로 운영하려면 `staging` 브랜치를 유지하는 편이 안전하다.

### 9.2 PR 검증

1. 의존성 고정 설치
2. lint·TypeScript 검사
3. `supabase db reset`으로 전체 마이그레이션 재현
4. DB 함수·RLS 테스트
5. 단위·컴포넌트 테스트
6. 애플리케이션 빌드
7. Playwright 핵심 E2E
8. Vercel Preview 생성
9. 환경 불변조건 검사

### 9.3 Staging 반영

1. pending migration 확인
2. `db push --dry-run`
3. staging DB 백업 또는 복구 가능 상태 확인
4. staging migration 적용
5. Vercel staging 배포
6. 관리자·PM·사용자·게스트 스모크 테스트
7. RLS·보고서·Storage 검증

### 9.4 Production 반영

1. 변경 승인과 배포 창구 확인
2. 운영 백업 및 마이그레이션 영향도 검토
3. 운영 DB 마이그레이션
4. 데이터 정합성·RLS 스모크 테스트
5. Vercel Production 배포
6. 로그인·핵심 CRUD·보고서·파일 확인
7. 오류율·지연시간 모니터링
8. 실패 시 앱 롤백 및 DB 전진 수정 절차 수행

DB 마이그레이션과 애플리케이션은 하위 호환 순서로 배포한다. 컬럼 추가→코드 전환→구 컬럼 제거처럼 expand/contract 방식을 사용한다.

## 10. 환경 불변조건

빌드와 배포 전에 자동 검사한다.

- `local` 빌드는 로컬 Supabase URL만 사용한다.
- `staging` 배포는 staging Supabase project ref만 사용한다.
- `production` 배포는 production project ref만 사용한다.
- Preview에 production `service_role`과 DB URL이 존재하면 배포를 중단한다.
- `NEXT_PUBLIC_*`에 서비스 키, DB 비밀번호, 개인키가 포함되면 빌드를 중단한다.
- migration history가 Git과 원격 DB에서 다르면 배포를 중단한다.
- RLS 미활성 업무 테이블이 있으면 배포를 중단한다.

## 11. 관측·백업·장애대응

### 11.1 관측

- Vercel: 배포 상태, Function 오류·실행시간, Web Analytics/Core Web Vitals
- Supabase: API/Auth/Postgres 로그, 연결 수, 느린 쿼리, Storage 오류
- 애플리케이션: 요청 ID, 사용자 ID의 비식별 식별자, 프로젝트 ID, 업무 이벤트
- 오류 수집: 클라이언트·서버 오류를 환경별로 분리

로그에는 토큰, 비밀번호, 서비스 키, DB URL, 첨부파일 원문, 민감 개인정보를 기록하지 않는다.

### 11.2 백업·복구

- Supabase 플랜별 백업 보존 정책을 확인한다.
- 운영 전 복구 시나리오와 목표 복구시간·복구시점을 확정한다.
- 마이그레이션 전 수동 백업이 필요한 변경 유형을 정의한다.
- Storage 파일과 DB 메타데이터의 복구 정합성을 함께 검증한다.
- staging에서 복구 리허설을 정기 수행한다.

### 11.3 장애 분류

| 장애 | 1차 확인 | 대응 |
|---|---|---|
| 로그인 실패 | Auth 로그, Site URL, Redirect URL | 설정 복구·세션 무효화 |
| 권한 오류 | JWT, 멤버십, RLS 정책 | 정책·인덱스·데이터 확인 |
| DB 연결 고갈 | 연결 수, 풀 설정, Vercel 동시 실행 | 풀 제한·Data API 전환·함수 동시성 점검 |
| Preview가 운영 데이터 접근 | Vercel 환경변수 | 즉시 키 폐기·재발급, 배포 차단 |
| 마이그레이션 실패 | migration history, SQL 오류 | 앱 배포 중단, 전진 수정 또는 승인된 복구 |
| 파일 접근 실패 | Storage 정책, 경로, Signed URL | 정책·메타데이터 정합성 확인 |

## 12. 개발 착수 순서

### 1단계: 인프라 기준선

- Git 저장소와 Next.js 프로젝트 생성
- Vercel 프로젝트 연결
- Supabase staging·production 프로젝트 분리 생성
- 로컬 Supabase 초기화
- 환경변수 이름과 관리 책임 확정

### 2단계: 데이터·보안 기준선

- 초기 migration 작성
- Auth profile, project, project_member, role 구조 구현
- RLS helper와 정책 테스트
- seed 및 DB 타입 생성 체계 구축

### 3단계: 인증·앱 셸

- 로그인·로그아웃·세션 갱신
- 한국어 메뉴와 프로젝트 선택
- 역할별 라우트·API 접근 제어

### 4단계: 핵심 업무

- 주간보고, 주간실적, 이슈, 인력변동
- 감사 로그, Storage 첨부
- 대시보드·캘린더·보고서

### 5단계: 원격 개발·운영 전환

- staging CI/CD
- Preview와 staging 통합 검증
- 운영 배포 승인 절차와 환경 불변조건
- 백업·복구·롤백 리허설

## 13. 착수 전 결정 필요사항

| 항목 | 선택지 | 권고 |
|---|---|---|
| Vercel 플랜 | Hobby / Pro 이상 | Custom Staging이 필요하면 Pro 검토 |
| Supabase 플랜 | Free / Pro 이상 | 백업·Branching·운영 SLA를 기준으로 결정 |
| Preview DB | 공용 staging / PR별 Branch | 가능하면 PR별 Branch |
| 인증 | 이메일·비밀번호 / SSO | 이메일·비밀번호 우선, SSO 확장 경계 유지 |
| 서버 데이터 접근 | Data API / SQL Pooler | Data API 우선, 트랜잭션에만 Pooler |
| 리전 | 국내 사용자와 가까운 지원 리전 | Vercel·Supabase 리전 지연시간 함께 검토 |
| 파일 보존 | Supabase Storage / 사내 저장소 | 초기에는 Supabase Storage, 정책 확인 |
| 운영 배포 | 자동 / 승인형 | DB와 Production은 승인형 |

## 14. 완료 기준

- 로컬에서 `supabase db reset`만으로 DB 구조와 샘플 데이터가 재현된다.
- staging과 production Supabase 프로젝트가 물리적으로 분리된다.
- Vercel Development·Preview/Staging·Production 환경변수가 분리된다.
- 브라우저 번들에 서버 비밀값이 포함되지 않는다.
- 관리자·PM/PMO·사용자·게스트 RLS 허용·차단 테스트가 통과한다.
- 외래키와 RLS 필터 컬럼의 인덱스가 검증된다.
- Preview가 운영 DB에 연결되지 않음을 자동 검사한다.
- staging에서 마이그레이션·배포·백업·복구 절차를 검증한다.
- 사용자 승인 없이는 운영 마이그레이션과 Production 배포를 수행하지 않는다.

## 15. 공식 참고문서

- [Supabase 로컬 개발과 마이그레이션](https://supabase.com/docs/guides/local-development/overview)
- [Supabase 로컬 개발 워크플로](https://supabase.com/docs/guides/local-development/cli-workflows)
- [Supabase 환경 관리](https://supabase.com/docs/guides/deployment/managing-environments)
- [Supabase 배포와 Branching](https://supabase.com/docs/guides/deployment)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Vercel 환경변수](https://vercel.com/docs/environment-variables)
- [Vercel 배포 환경](https://vercel.com/docs/deployments/environments)
- [Vercel Functions 연결 풀링](https://examples.vercel.com/kb/guide/connection-pooling-with-functions)

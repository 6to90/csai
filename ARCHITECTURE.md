# ARCHITECTURE — 시스템 구조 및 모듈 설계

참조: [CLAUDE.md](CLAUDE.md) · [PRD.md](PRD.md) · [DATABASE.md](DATABASE.md) · [API.md](API.md)

## 1. 개요
모듈형 모놀리스. Next.js(App Router)가 UI와 API(Route Handler)를 모두 제공하고, Supabase가 DB·Auth·Realtime·Storage를 담당한다. 비동기 작업은 **Postgres 기반 잡 큐**(`jobs` 테이블)로 처리해 별도 유료 큐 서비스를 쓰지 않는다.

```
 고객(이메일/웹채팅/[전화])           상담원·관리자 브라우저
        │                                    │
  [Channel Adapters] ──▶ webhook_events      Next.js UI (RSC + Client)
        │  (서명검증, 멱등)                   │ 사용자 JWT (RLS)
        ▼                                    ▼
  ┌──────────────────── Next.js Route Handlers (api/v1) ────────────────────┐
  │ authn → authz(org, role) → Zod → domain service → audit_log             │
  └───────┬───────────────────────────────┬─────────────────────────────────┘
          │ service_role(서버 전용)        │ user client(RLS)
          ▼                               ▼
   Job Worker (/api/internal/jobs/run) ─▶ Supabase Postgres (RLS, pgvector, Realtime)
          │                                   ▲
          ├─▶ AI Orchestrator ─▶ LlmProvider ─┤
          ├─▶ Workflow Engine ─▶ ToolRunner ──┘ (승인 게이트)
          └─▶ Channel Adapters (발송)
```

## 2. 배포
- 앱: Vercel 무료 티어 또는 자체 Node 호스팅(둘 다 가능하게 플랫폼 종속 기능 회피). DB: Supabase(개발은 `supabase start` 로컬).
- 잡 트리거: 배포 환경의 cron(또는 Supabase `pg_cron` → HTTP)이 `/api/internal/jobs/run`을 1분마다 호출, `CRON_SECRET` 헤더 필수. 웹훅 수신 시에도 즉시 1회 깨움(best effort).
- 환경 변수: `SUPABASE_URL`, `SUPABASE_ANON_KEY`(공개 가능), `SUPABASE_SERVICE_ROLE_KEY`(서버 전용), `SECRETS_MASTER_KEY`(서버 전용), `CRON_SECRET`.

## 3. 모듈 구조
모듈은 `src/features/<module>`(UI) + `src/server/domain/<module>`(로직)로 나뉜다. 모듈 간 호출은 domain 공개 함수만 사용(순환 금지).

| 모듈 | 책임 | 주요 테이블(DATABASE.md) | 주요 API(API.md) |
|---|---|---|---|
| Unified Inbox | 대화·메시지 수집/표시/배정 | conversations, messages, attachments, channel_accounts | §3 conversations, §2 chat |
| AI Agents | 에이전트 설정, 응답 생성 오케스트레이션 | ai_agents, agent_versions | §4 agents |
| Knowledge Base | 수집·청킹·임베딩·검색 | kb_sources, kb_documents, kb_chunks | §5 kb |
| Workflow Engine | 트리거·스텝 실행·재시도 | workflows, workflow_versions, workflow_runs, workflow_run_steps | §6 workflows |
| Human Control | 승인 정책·대기열·Takeover·Kill switch | approval_policies, approval_requests | §7 approvals |
| Customer CRM | 고객 병합·필드·태그 | customers, customer_identities | §8 customers |
| Analytics | 집계 뷰·지표 | 뷰 `v_conversation_metrics`, usage_events | §9 analytics |
| Integrations | 채널·외부 시스템·비밀 | integrations, integration_secrets, webhook_events | §10 integrations |
| (횡단) Security | authz, secrets, audit, idempotency, 멤버·초대 | audit_logs, idempotency_keys, memberships, invitations, chat_sessions | §10.1 org/members/invitations |

## 4. 어댑터 계층 (`src/server/adapters`)
모든 외부 연동은 인터페이스 + 구현체 + 계약 테스트로 구성. 상세 시그니처는 API.md §13.

### 4.1 ChannelAdapter
```ts
interface ChannelAdapter {
  kind: 'email' | 'web_chat' | 'voice';
  verifyInbound(req: Request, acct: ChannelAccount): Promise<VerifiedPayload>; // 서명/토큰 검증
  normalize(payload): InboundMessage;        // → 공통 형식
  send(acct, out: OutboundMessage, idempotencyKey: string): Promise<SendResult>;
  capabilities: { attachments: boolean; threading: boolean; realtime: boolean }; // 채널 종류는 kind로 구분하므로 voice 플래그는 두지 않는다
}
```
- `email`: MVP는 **인바운드 웹훅**(예: 무료 포워딩/파서) + **SMTP 발송**. IMAP 폴링 어댑터는 같은 인터페이스로 후속.
- `web_chat`: 방문자 위젯 ↔ Route Handler(**SSE, 실패 시 폴링**). 상담원·관리자 화면만 Supabase Realtime(사용자 JWT, RLS 적용). 방문자는 Supabase에 직접 연결하지 않는다. 외부 SaaS 불필요.
- `voice`: 인터페이스와 `voice` enum, `messages.content_type='transcript'`만 선반영. 구현은 후속(STT/TTS/SIP 공급자는 어댑터로 교체). 전화 통화는 "통화 = Conversation, 발화 = Message(transcript)"로 같은 파이프라인에 합류.

### 4.2 LlmProvider
```ts
interface LlmProvider { complete(req: LlmRequest): Promise<LlmResponse>; embed(texts: string[]): Promise<number[][]>; }
```
구현: `mock`(테스트·기본), `ollama`(로컬), `byok-*`(고객 자체 키, `integration_secrets`에서 로드). 응답은 구조화(JSON) 도구 호출 형식으로 정규화.

### 4.3 ExternalToolAdapter
HTTP 기반 커넥터. 호스트 **허용 목록**(`integrations.config.allowed_hosts`)만 호출, SSRF 방지(사설 IP·메타데이터 주소 차단, 리다이렉트 재검증), 타임아웃 10s, 응답 크기 제한.

## 5. 핵심 흐름
### 5.1 인바운드 → AI 응답
1. 웹훅 도착 → URL 식별자로 채널 계정·`org_id` 확정 → 해당 조직 비밀로 `verifyInbound`(서명) → **통과 시에만** `webhook_events`에 `(org_id, channel_account_id, external_event_id)` 유니크 INSERT. 중복이면 200 반환 후 종료. 서명 실패·미등록 식별자는 저장하지 않으므로 "조직 미확인 이벤트"는 존재하지 않는다. (위젯 요청은 방문자 세션 토큰이 `org_id`를 결정.)
2. `jobs`에 `process_inbound` 등록(멱등 키 = webhook_event id).
3. 워커: 고객 식별(`customer_identities`) → Conversation upsert → Message 저장 → Realtime 이벤트.
4. Conversation이 `ai_enabled`이고 Kill switch 꺼짐, 담당 상담원 없음(Takeover 아님)이면 `ai_respond` 잡 등록.
5. `ai_respond`: 에이전트 선택 → KB 검색(RAG) → LLM 호출 → 응답/도구 호출 제안 파싱.
6. 각 도구 호출은 **PolicyGate**(§6.2) 통과. 허용되면 실행, 아니면 `approval_requests` 생성.
7. 답변 발송은 `draft` 모드면 초안 저장(상담원 확인), `assist/auto`면 정책 따라 발송. 전 과정 `audit_logs`.

### 5.2 승인 후 실행
승인 결정(`POST /approvals/{id}/decision`) → 트랜잭션으로 상태 `approved` + 실행 잡 등록(멱등 키 = approval_id) → 워커가 payload 해시 검증 후 1회 실행.

## 6. 횡단 설계
### 6.1 멀티테넌시·인가
- 모든 요청: JWT → `memberships` 조회 → `org_id`·역할 결정. URL의 `orgSlug`는 힌트일 뿐 멤버십 검증이 우선.
- DB: RLS(`is_member(org_id)`, `has_role(org_id, roles)`). 서버 `service_role` 사용 지점은 `src/server/security/system-client.ts` 한 곳으로 제한하고 호출 시 `org_id` 강제.
- 공개 위젯(비로그인 방문자) 보안 정책:
  1. **세션 발급**: `public_key`(공개 식별자) + `Origin`이 `channel_accounts.config.allowed_origins`에 있어야 발급. 서버가 **불투명 난수 토큰**(32바이트)을 발급하고 SHA-256 해시만 `chat_sessions`에 저장(서명 JWT 대신 즉시 폐기 가능한 방식). 토큰은 `Authorization: Bearer`로만 전달(쿠키 미사용 → CSRF 무관), 위젯은 메모리/`sessionStorage`에만 보관.
  2. **스코프**: 토큰 하나 = 대화 하나. 다른 대화·고객·조직 접근 불가. 매 요청 `chat_sessions` 조회로 만료(절대 24h/유휴 30분)·폐기(`revoked_at`, 대화 `closed`) 확인. 상담원이 세션을 폐기할 수 있다.
  3. **전달**: `GET /chat/sessions/{id}/stream`(SSE, `Last-Event-ID` 재개, 15초 하트비트, 연결당 최대 55초 후 재연결 유도 — 서버리스 시간 제한 대비) → 실패/미지원 시 `GET …/messages?after=` 폴링(3~5초, 비활성 탭은 지수 증가).
  4. **신원**: 방문자 식별자는 **미검증**. 방문자가 입력한 이메일은 고객과 자동 병합하지 않고 `unverified`로 표시한다. 고객 개인 정보·계정 조회를 하는 도구는 검증된 신원에서만 허용(PolicyGate 입력에 `identity_verified` 추가).
  5. **남용 방지**: 세션 생성 IP당 10/min, 세션당 메시지 20/min, 본문 4,000자, 조직당 동시 활성 세션 상한. 초과 시 `429`. 메시지는 `Idempotency-Key` 필수.
  6. **노출 최소화**: 방문자에게는 `outbound` 공개 메시지만 전달(내부 메모·AI 초안·시스템 내부 정보 제외). 위젯 입력은 데이터로 취급(프롬프트 인젝션 방어, CLAUDE §3-7). 출력은 텍스트로만 렌더링(HTML 이스케이프).

### 6.2 PolicyGate (사람 승인)
입력: (agent, tool, args, 위험도, 모드, kill_switch, identity_verified). 순서: ① Kill switch/모드 확인 ② 도구 위험도 분류(도구 레지스트리 고정 값, AI가 정하지 않음) ③ `approval_policies` 매칭(조직→에이전트 순) ④ 결과 `allow | require_approval | deny`. `high`는 `allow` 불가. 결과와 근거를 `audit_logs`에 기록.

### 6.3 멱등성·중복 실행 방지
| 계층 | 장치 |
|---|---|
| 웹훅 수신 | `webhook_events` UNIQUE(org_id, channel_account_id, external_event_id) |
| 공개 API(POST) | `Idempotency-Key` 헤더 → `idempotency_keys` UNIQUE(org_id, scope, key), 응답 재생 |
| 잡 | `jobs.dedupe_key` UNIQUE(org_id, type, dedupe_key); 원자적 claim(`FOR UPDATE SKIP LOCKED`) + `locked_until` 리스 + 만료된 `running` 재수집 + 완료 시 `locked_by` 펜싱(DATABASE §6), 재시도 최대 5회·지수 backoff |
| 워크플로 | `workflow_runs` UNIQUE(workflow_id, trigger_key), 스텝은 `(run_id, step_key)` UNIQUE, 완료 스텝은 재시도 시 건너뜀 |
| 외부 발송 | 어댑터 호출에 `idempotency_key` 전달, 결과를 `messages.external_id`로 UNIQUE 보장 |
| 승인 실행 | `approval_requests.executed_at` 조건부 UPDATE(`WHERE executed_at IS NULL`) 성공한 1건만 실행 |

#### 6.3.1 잡 복구 시나리오 (at-least-once 전달 + 멱등 핸들러)
| 상황 | 동작 |
|---|---|
| 워커가 처리 중 프로세스 종료/배포 재시작 | 리스(2분) 만료 후 다음 실행의 claim이 `running`+만료 작업을 재수집, `attempts` 증가. 핸들러는 멱등이므로 재실행 안전 |
| 두 워커가 동시에 claim | `SKIP LOCKED`로 서로 다른 행 획득. 같은 작업이 겹치는 경우는 없음 |
| 느린 워커가 리스 만료 후 뒤늦게 완료 보고 | 펜싱 조건(`locked_by`)이 0행 → 결과 폐기, 이미 재수집한 워커가 정본 |
| 부작용 직후 완료 기록 전에 중단 | 재실행 시 멱등 키로 중복 방지: DB 쓰기는 유니크 제약, 외부 API는 `Idempotency-Key` 전달 |
| **멱등 키를 지원하지 않는 발송(SMTP)** | 중복 발송 가능 구간 존재. 메시지를 `queued→sending→sent`로 전이하고, 재수집 시 `sending`에 멈춘 건은 **자동 재발송하지 않고** 상담원 확인 대기(`failed`+사유)로 전환(at-most-once 우선) |
| 재시도 소진 | `dead` 전환, 감사 로그·관리자 화면 표시, 수동 재큐(새 `dedupe_key` 접미사) 가능 |
| cron 누락/지연 | 다음 호출이 밀린 작업을 처리. 웹훅/위젯 수신 시 즉시 깨움은 best effort일 뿐 정합성에 의존하지 않음 |
| 전체 중단 후 재개 | 모든 `running` 리스가 만료되어 순서대로(`run_at`) 재수집 |

### 6.4 비밀 관리
`integration_secrets`는 앱 계층 **봉투 암호화(AES-256-GCM)**: 조직별 데이터 키를 `SECRETS_MASTER_KEY`로 감싸 저장. 복호화는 서버 `secrets.get(orgId, integrationId, name)`에서만, 사용 직전에만 수행하고 메모리에 오래 두지 않는다. RLS로 일반 사용자 SELECT 전면 차단(서비스 역할만). 키 교체 시 재암호화 잡 제공. (Supabase Vault 사용 가능 시 대체 가능하나 인터페이스는 동일 유지.)

### 6.5 감사 로그
`audit(ctx, action, target, before?, after?)` 헬퍼를 도메인 함수가 호출. **메타데이터는 DB의 액션별 허용 목록(DATABASE §5)을 통과해야 하며 자유 형식 텍스트는 기록할 수 없다.** 필드: actor(user|ai_agent|system), org_id, action, target_type/id, metadata, ip, request_id. **MVP는 해시 체인 없이 append-only + 중요 변경은 같은 트랜잭션 기록**(DATABASE §5). 비밀 값·메시지 본문·도구 인자 원문은 저장하지 않고 ID/해시만.

### 6.6 가관측성·신뢰성
구조화 로그(`request_id`), 잡 실패는 지수 백오프(최대 5회) 후 `dead` 상태 + 관리자 알림, 헬스체크 `/api/v1/health`.

### 6.7 레이트 리밋
- **서버리스 인스턴스 메모리에 카운터를 두지 않는다**(인스턴스마다 값이 달라 한도가 무력화됨).
- MVP 저장소: Postgres `rate_limits`(UNLOGGED) + 원자적 RPC `rate_limit_hit`(DATABASE §2.5). 고정 윈도라 경계에서 최대 2배 순간 버스트가 가능하지만 MVP에서는 허용한다.
- 쓰기 부하 억제: 인증 사용자는 변경 요청과 비싼 읽기(검색·분석)만 카운트하고 일반 GET은 제외. 오래된 윈도는 시스템 유지보수 함수 `purge_rate_limits`(DATABASE §6.1)가 삭제.
- 장애 정책: 공개 엔드포인트(위젯·웹훅·초대 수락)는 카운터 오류 시 **fail-closed(429)**, 인증된 내부 API는 **fail-open + 경고 로그**.
- IP는 일일 솔트 해시로만 저장. 한도 단위: 사용자·조직·방문자 세션·IP·초대 대상.
- 호출부는 `RateLimiter.hit(key, limit, windowSec)` 인터페이스만 사용 → 트래픽 증가 시 Redis 호환 저장소 어댑터로 교체 가능(현 단계 도입 안 함, 유료 서비스 금지).

### 6.8 계정 보안(CAPTCHA·MFA)과 보안 헤더 (Phase 2C)
- **CAPTCHA(계정 열거 완화)**: Supabase Auth의 공식 CAPTCHA(Cloudflare Turnstile, 무료)를 켠다. GoTrue가 가입·비밀번호 로그인·복구·OTP에서 서버측으로 토큰을 검증하므로 **anon 키로 직접 호출해도 토큰 없이는 400 `captcha_failed`**. 관리자 API(service_role)는 대상 아님. 로컬: `supabase/config.toml [auth.captcha]`(secret은 `env(SUPABASE_AUTH_CAPTCHA_SECRET)`, 로컬 테스트는 Cloudflare 공개 더미 시크릿). **운영 프로젝트에는 Supabase 대시보드(Auth → Attack Protection)에서 실제 Turnstile 시크릿을 별도로 설정해야 하며 config.toml은 운영에 자동 반영되지 않는다.** UI는 `interaction-only` 위젯이라 평소 사용자는 추가 조작이 없다.
- **MFA**: Supabase Auth TOTP. owner/admin은 aal2 필수(DATABASE §3). UI: 로그인 직후 TOTP 등록 계정은 코드 입력 단계가 나오고, 미등록 owner/admin은 대시보드 대신 `MfaGate`(QR 등록→코드 확인)가 나온다. 일반 멤버·조회자는 변화 없음. API는 `requireOrg`에서 aal을 확인해 `403 mfa_required`. **분실 복구(운영 절차)**: 운영자가 service_role로 `DELETE /auth/v1/admin/users/{id}/factors/{factorId}` 후 사용자가 재등록(테스트로 확인). 복구 코드는 제공되지 않는다.
- **보안 헤더**(`src/lib/security-headers.ts` → `src/proxy.ts`): 페이지는 요청마다 nonce를 만들어 `script-src 'self' 'nonce-…' 'strict-dynamic'`(+Turnstile), `style-src 'self' 'nonce-…'`, `connect-src 'self' <Supabase origin>`, `frame-src`는 Turnstile만, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri/form-action 'self'`. 운영에서 `unsafe-inline`·`unsafe-eval` 없음, 개발은 React 개발도구·HMR용으로 완화. API는 `default-src 'none'`. **HSTS는 `APP_URL`이 https이고 production일 때만**(max-age 2년, includeSubDomains; preload는 도메인 확정 후 결정). `Permissions-Policy`는 camera/microphone/geolocation/payment 등 기본 차단(전화·음성 채널 추가 시 microphone을 의도적으로 허용). 루트 레이아웃이 `headers()`를 읽어 모든 페이지가 동적 렌더링(정적 페이지는 nonce를 붙일 수 없음).
- **가입 정책(Phase 2D, 초대 전용)**: `supabase/config.toml [auth] enable_signup=false` → 공개 `/auth/v1/signup`은 존재 여부와 무관하게 `422 signup_disabled`(CAPTCHA 검증 뒤)로 동일 응답하므로 **가입 경로의 이메일 열거 오라클이 닫혔다**(테스트로 확인). `[auth.email] enable_signup`은 이메일 *로그인* 공급자 스위치라 `true`로 유지해야 한다(false면 로그인도 막힘). 계정은 운영자가 service_role 관리자 API(`POST /auth/v1/admin/users`)로 발급하고, 초대받은 사용자는 로그인 후 기존 `/api/v1/invitations/accept`로 수락한다. 조직 생성·보호 API는 로그인(이메일 확인 완료) 세션만 가능(미인증 401). UI는 `NEXT_PUBLIC_SIGNUP_MODE`(기본 invite_only, `src/lib/signup-policy.ts`)로 가입 버튼을 숨긴다 — **공개 가입 재개 = `enable_signup=true`(GoTrue, 운영은 대시보드) + `NEXT_PUBLIC_SIGNUP_MODE=open` 두 곳**이며, 이때 열거 오라클(`user_already_exists`)이 되돌아오므로 CAPTCHA·레이트 리밋 재검토 필요. 운영 프로젝트의 가입 설정은 config.toml로 반영되지 않는다(대시보드 Auth → Sign In / Providers에서 "Allow new users to sign up" 해제).
- **온보딩(Phase 3A)**: Supabase `inviteUserByEmail`은 쓰지 않고 기존 커스텀 초대(해시 토큰·조직·역할·만료·감사)를 유지한다 — 공식 흐름은 조직/역할을 모르고, 수락 전에 계정을 만들며, 기존 사용자 처리가 따로 필요하기 때문. 신규 이메일은 `/invite`에서 토큰으로 `redeem`(계정 생성, 이메일 확인 처리)→로그인(CAPTCHA)→`accept`; 기존 계정은 같은 화면에서 로그인→`accept`. 첫 고객사 소유자는 운영자가 `POST /api/internal/customers`로 발급(`provision_customer`: service_role 전용 RPC, `invited_by`=null=시스템, 감사 `actor_type=system`). 메일은 `adapters/mail`(Mailpit 개발용·최소 SMTP) 경유. **한계**: 계정 생성(`redeem`)은 별도 감사 행이 없고(멤버십 생성은 `invitation.accept`로 기록), SMTP의 TLS·AUTH 경로는 실제 서버로 검증하지 않았다(평문 경로만 모의 서버로 단위 테스트).

- **세션·리프레시**: `enable_refresh_token_rotation=true`, 재사용 간격 10초(기본), `jwt_expiry=3600`. 관측: 직전 부모 토큰 재사용은 현재 토큰을 돌려주고, 그보다 오래된 토큰은 거부되지만 세션 패밀리는 폐기되지 않음(테스트 기록). 로그아웃은 세션을 폐기해 이전 액세스 토큰이 즉시 401(테스트). `[auth.sessions]` timebox/inactivity는 호스티드 Pro 기능이라 설정하지 않았고 필요 시 운영 플랜 확인.
- **TOTP 재사용(조사 결과)**: Supabase 공식 MFA 문서는 enroll→challenge→verify 흐름만 설명하며 사용한 코드의 단일 사용(RFC 6238 §5.2)이나 재사용 방지에 대한 보증을 명시하지 않는다. 로컬 GoTrue 테스트에서 방금 쓴 코드가 시간창 안에서 다시 승인됨을 관측했다. 서버 설정으로 제어할 수 없으므로 앱에서 우회 구현하지 않는다(GoTrue 외부에서 코드를 가로채 재검증할 방법이 없음). 완화: 로그인 레이트 리밋·CAPTCHA, 짧은 코드 수명, MFA 챌린지 시도 제한(GoTrue 기본). 동작이 바뀌면 `tests/real/security.test.ts` 단언이 깨져 재검토 신호가 된다.
- **MFA 복구 권한**: 복구는 service_role을 가진 운영자만 수행(위 절차). 요청자 본인 확인 절차(운영 정책)는 별도로 정해야 하며, 복구 시 감사 기록은 운영자가 수동으로 남긴다(관리자 API 호출은 앱 `audit_logs`를 거치지 않음 — 잔여 위험 ⑦).
- **잔여 위험(미해결, 문서화)**: ① (해소: 가입 경로 열거는 초대 전용으로 차단. 남은 열거 표면: 이메일 로그인 오류는 동일 응답이라 없음, `/recover`·`/otp`는 CAPTCHA 뒤에서 응답이 동일한지 운영 환경에서 재확인) ② GoTrue는 방금 사용한 TOTP 코드를 시간창 안에서 재사용 허용 ③ 리프레시 토큰 재사용 시 오래된 토큰은 거부되지만 세션 패밀리는 폐기되지 않음 ④ `strict-dynamic`은 DOM XSS 싱크를 막지 못함(입력 이스케이프로 방어) ⑤ 레이트 리밋은 고정 윈도 ⑥ HSTS·CSP는 HTTPS 운영 환경에서 실제 검증 전 ⑦ 운영자 관리자 API 작업(계정 발급·MFA 복구)은 앱 감사 로그에 남지 않음

### 6.9 운영 이메일 (Phase 3C-A)
**수신 방식 비교와 결정**
| 방식 | 비용 | 운영 안정성 | 평가 |
|---|---|---|---|
| **서명된 원문(RFC 5322) 웹훅** ← 기본 | 앱 자체는 무료. 전달자는 무엇이든 가능: **Cloudflare Email Routing + Email Worker**(Email Routing 수신은 무료, Worker는 Workers 요금제 한도 적용 — 문서 확인 2026-11), Postfix pipe, 메일 공급자의 raw 포워딩 | 서버리스에 적합(상시 프로세스 없음), 재전송 시 중복 방지 내장 | 채택: 공급자 종속 없음, 표준 MIME |
| IMAP 폴링 | 무료(고객 메일함) | 상시 연결/폴링 필요, Gmail 등은 OAuth·앱 비밀번호 필요, 잡 러너 1분 주기 한계, 패키지 없이 IMAP 클라이언트 구현은 부담 | 후속(고객 요청 시) |
| 유료 인바운드 파싱(Mailgun/Postmark/SendGrid 등) | 유료 또는 제한적 무료 — **도입 전 별도 승인 필요, 이번에 도입하지 않음** | 안정적이나 공급자 JSON 형식·서명 방식이 제각각 | 필요하면 같은 JSON 웹훅 스키마로 어댑트 |
| 자체 MX(SMTP 수신 서버) | 서버 비용+스팸/보안 운영 부담 | 25번 포트 상시 서버 | 비추천 |
- 웹훅 `POST /api/v1/webhooks/email/{channel_id}`는 `Content-Type: message/rfc822`(원문) 또는 정규화 JSON을 받는다. 서명은 **수신한 원문 바이트**에 대해 `HMAC-SHA256(secret, "{ts}.{bytes}")`, ±5분. **조직 라우팅은 URL의 채널 ID로만** 결정하며 메일 헤더(To 등)는 조직 결정에 쓰지 않는다. 예제: `scripts/cloudflare-email-worker.mjs`(서명 로직은 Node에서 검증, Cloudflare 런타임에서는 **미검증**).
- **파싱(`domain/mime.ts`, 패키지 없음)**: 헤더 접기 해제, RFC 2047 인코딩 단어, RFC 2231 파일명, multipart(깊이 ≤8·파트 ≤60), quoted-printable/base64, 문자셋(TextDecoder), 발신자·수신자·제목·Message-ID·In-Reply-To·References·Date, `Auto-Submitted`/`Precedence`(bulk) 표시. 제어문자(CR/LF/NUL)는 모든 헤더 유래 필드에서 제거.
- **HTML/첨부 안전**: HTML 메일은 **텍스트로 변환해 저장**(script/style/태그/이벤트 속성 제거, 엔티티 해석)하며 HTML 원문은 저장·렌더링하지 않는다(UI는 텍스트 노드). 첨부는 메타데이터만(이름은 경로·제어·양방향 문자 제거, 크기는 디코딩된 바이트, MIME은 라벨일 뿐 신뢰 안 함), 파일 바이트는 저장하지 않고 `scan_status=pending`.
- **스레딩**(`process_inbound`): ① 알려진 부모(`In-Reply-To`/`References` ↔ `messages.external_id`) ② **먼저 도착한 자식**(`messages.refs`가 내 Message-ID를 포함) ③ 스레드 키(첫 References 또는 자기 ID). 부모보다 먼저 온 답장은 일단 별도 대화로 만들고, 부모/중간 메일이 도착하면 같은 대화로 합류한다. **스레딩은 같은 고객 안에서만** — Message-ID는 비밀이 아니므로 남의 ID를 인용한 메일은 그 대화에 들어갈 수 없다(별도 대화). 이미 저장된 메시지는 이동·수정하지 않는다. 한계: 서로 다른 고아 대화 둘을 합치는 병합은 하지 않는다.
- **SMTP(`adapters/mail`)**: `smtps://`(암묵 TLS)·`smtp+starttls://`·`smtp://`(자격증명 금지). **인증서·호스트명은 항상 검증**, STARTTLS 미지원 서버에 평문 폴백 없음, 자격증명은 암호화된 연결에서만 전송, AUTH PLAIN/LOGIN. 오류 분류: `transient`(4xx·네트워크 → 백오프 재시도, 최대 5회) / `permanent`(5xx·인증서·인증 실패 → 즉시 `failed`, 코드 기록) / **`uncertain`(본문 전송 후 응답 전에 연결 소실 → 자동 재시도 금지**, `failed`+`uncertain_delivery`, 사람이 수동 재시도; 같은 Message-ID라 수신 측이 중복 제거). 결과는 `record_send_result`가 상태·서버 응답 참조(`delivery_ref`)·감사(`email.send`)를 한 트랜잭션으로 기록. 수신은 `email.receive` 감사(메타데이터 없음). 발신 주소=채널 `address`, 표시 이름=`from_name`(RFC 2047).
- **운영 체크리스트(이메일)**: 발신 도메인의 **SPF·DKIM·DMARC**는 SMTP 공급자/도메인 DNS에서 설정해야 한다(이 앱은 DKIM 서명을 하지 않는다). 회신 주소(`address`)가 실제 수신 가능한 지원 주소여야 스레딩이 이어진다. SMTP 비밀번호는 채널 생성 시 `smtp_url`로만 입력(암호화 저장, 재조회 불가).
- **미검증**: 실제 외부 SMTP 공급자·실제 Cloudflare 런타임·실제 메일 클라이언트가 만든 다양한 MIME 변형. 자기 주소 발신 메일/`auto_submitted` 메일은 파싱·플래그만 하고 아직 처리 분기는 없다(AI 응대 단계에서 사용).

### 6.10 웹 채팅 위젯 (Phase 3C-B)
- **설치**: 채널 화면에서 "웹 채팅 위젯"을 만들면 공개 식별자(`public_key`)와 설치 스니펫이 나온다. 고객사는 `<script src="https://<앱>/widget.js" data-key="<public_key>" async></script>`를 페이지에 붙인다(`data-lang=ko|en`, `data-user-name`, `data-user-email`+`data-user-hash` 선택). 고객사가 CSP를 쓰면 `script-src`·`connect-src`에 앱 출처를 허용해야 한다. `/widget.js`는 정적 파일(`public/`, `Cache-Control: public, max-age=300`)이므로 수정 배포 후 반영에 최대 5분 걸린다(필요 시 `?v=` 사용).
- **공개 식별자 vs 비밀키**: `public_key`는 위젯을 식별할 뿐 **권한이 없다**(관리자·상담원 API는 사용자 JWT만 받고, 키·방문자 토큰으로는 항상 401). 방문자 접근은 세션 토큰이 결정한다. 선택 기능 **ID 검증**: 고객사 **서버**가 `HMAC-SHA256(identity_secret, email)`을 계산해 위젯 속성으로 넘기면, 서버가 상수 시간 비교로 검증한 뒤 해당 이메일 고객으로 연결(이메일 채널과 같은 고객). 증명이 틀리면 익명으로 강등하지 않고 `403 identity_invalid`. `identity_secret`은 채널 생성/재발급 응답에서만 1회 표시, `integration_secrets`에 암호화 저장, 재발급 시 이전 비밀 즉시 무효(감사 `channel.secret`).
- **세션**: 불투명 난수 토큰(해시만 저장), 한 토큰=한 대화, `Authorization: Bearer`(쿠키 없음 → CSRF 무관, `credentials:'omit'`), 토큰은 `sessionStorage`. 매 요청 검증: 만료(24h)·유휴(30분)·폐기·**세션 Origin 일치**·**채널 활성**·**Origin이 여전히 허용 목록에 있음**(위젯 일시중지/출처 제거는 기존 세션에 즉시 적용). 세션별 제한: 전송 20/분·500/일, 폴링 60/분, 스트림 30/분; IP별 세션 생성 30/시간.
- **실시간**: `GET /chat/stream`(SSE). `fetch`+스트림 파서(EventSource는 헤더를 못 보냄). 연결당 최대 55초(서버리스 대비) 후 서버가 종료 → 위젯이 즉시 재연결(`?after`/`Last-Event-ID`). 이벤트 ID=메시지 `created_at`, 경계 중복은 허용하고 **클라이언트·서버가 메시지 id로 제거**. 15초 하트비트(+`last_seen_at` 갱신=유휴 방지·온라인 표시). 상담원이 종료/폐기하면 `closed` 이벤트 후 종료. 연속 3회 스트림 실패 시 **4초 폴링 폴백**(패널이 닫혀 있으면 20초 폴링으로 미확인 배지). 오프라인/온라인 이벤트·지수 백오프(최대 30초)·페이지 가시성 복귀 처리. 서버는 스트림마다 1.5초 간격으로 DB를 조회한다(소규모 동시 접속 전제; 대규모는 Realtime/큐 기반으로 교체 필요).
- **상담원 측**: 방문자 메시지는 기존 Inbox Realtime으로 표시, 답장은 SSE로 방문자에게 즉시 전달. 상담원 "채팅 종료"(`end_chat` RPC, agent+·감사 `chat.revoke`)는 해당 대화의 모든 방문자 세션을 폐기하고 대화를 `closed`로. Inbox 상세에 방문자 온라인/오프라인/종료 표시(최근 60초 내 활동). 방문자가 "상담 종료"를 누르면 자기 세션만 폐기.
- **XSS/인젝션**: 위젯 UI는 Shadow DOM(호스트 CSS·스크립트와 분리), **모든 서버·방문자 텍스트는 `textContent`로만 기록**(HTML 파싱 없음; `innerHTML`/`eval`/`document.write`/쿠키 미사용을 정적 테스트로 강제). 방문자 입력은 제어문자·양방향 제어문자를 제거하고 그대로 데이터로 저장하며 아무 동작도 유발하지 않는다(자동 응답/AI 없음 — AI 단계에서도 메시지는 지시가 아닌 데이터, CLAUDE.md §3.7). 내부 메모·초안·대기 중 메시지는 방문자 API에 절대 노출되지 않는다.
- **알려진 한계**: 위젯 번들은 단일 파일(버전/무결성 해시 미제공 → 고객사가 SRI를 쓰려면 파일을 고정 복사해야 함); 파일 첨부·이모지 선택기·입력 중 표시·방문자 대화 이력(새 세션=새 대화)·다국어 확장(ko/en만) 없음; 방문자 IP는 해시로만 저장; 서버리스 동시 스트림 수 한도는 호스팅 환경에 의존.

### 6.9 아웃바운드 연결과 이그레스 제한 (SSRF)
- **테넌트가 지정하는 대상**(채널별 `smtp_url`)은 신뢰하지 않는다: 저장 시 프로토콜·포트 정책과 해석된 **모든** 주소의 공인 여부를 검사하고, 연결 시점에 소켓이 실제로 쓰는 주소를 다시 검사한다(`src/server/security/net-guard.ts`, DNS 재바인딩 방어). 사설·loopback·링크 로컬·CGNAT·메타데이터·예약 대역은 차단.
- **운영자 설정**(`MAIL_SMTP_URL`, `MAIL_HTTP_URL`)은 신뢰된 서버 설정으로 취급해 검사하지 않는다. 따라서 이 검사는 **애플리케이션 계층의 1차 방어일 뿐**이며, 운영 환경에서는 앱 호스트의 **네트워크 이그레스 제한**(허용 목록 기반 방화벽/보안 그룹: 메일·Supabase·LLM 공급자 등 필요한 목적지·포트만 허용, 클라우드 메타데이터 주소 `169.254.169.254` 차단, 프록시를 통한 아웃바운드)을 함께 적용해야 한다. 향후 LLM·외부 시스템 어댑터가 추가되면 같은 가드를 재사용하거나 이그레스 프록시를 둔다.
- 테스트 예외 `SMTP_ALLOW_PRIVATE_HOSTS=1`은 **`CSAI_TEST_BUILD=1`로 빌드된 산출물(또는 단위 테스트 러너)에서만** 유효하다. 프로덕션 빌드는 빌드 시점 상수로 이를 무시하므로 런타임 환경 변수로 켤 수 없다(`next.config.ts`, 검증: `tests/api/smtp-guard.test.ts`).

## 7. 확장 포인트 (전화)
`voice` 어댑터가 추가될 때 변경 범위: `adapters/voice/*`, `channel_accounts.kind='voice'` 설정 UI, 실시간 오디오 세션 서비스(별도 프로세스 가능). 코어(Inbox/Agents/Workflow/Approval)는 변경 불필요해야 한다 — 이것이 어댑터 설계의 합격 기준이다.

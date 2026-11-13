# ROADMAP — 단계별 개발 및 검증 계획

참조: [CLAUDE.md](CLAUDE.md) §6(완료 정의) · [PRD.md](PRD.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [DATABASE.md](DATABASE.md) · [API.md](API.md) · [DESIGN.md](DESIGN.md)

각 Phase는 **종료 게이트**를 통과해야 다음으로 진행한다. 모든 단계에서 유료 패키지·API·결제 연동 금지.

| Phase | 목표 | 상태 |
|---|---|---|
| 1 | 설계 문서 | 완료(본 문서군) |
| 2 | 기반: 프로젝트·DB·인증·멀티테넌시 | 다음 |
| 3 | Inbox + 웹 채팅 + 이메일 수신/발송 | |
| 4 | AI Agents + KB + Human Control | |
| 5 | Workflow Engine + CRM + Analytics | |
| 6 | 하드닝·파일럿 | |
| 7+ | 전화 어댑터 등 확장 | |

## Phase 2 — 기반
- Next.js+TS+Tailwind 스캐폴드, 디자인 토큰·App Shell·기본 UI 컴포넌트(DESIGN §2–4)
- Supabase 로컬 환경, 마이그레이션: organizations/profiles/memberships, `is_member`/`has_role`, `audit_logs`, `idempotency_keys`, `jobs`, `integration_secrets`+`org_keys`, `invitations`, `rate_limits`+`rate_limit_hit`, `append_audit`
- 인증(이메일 로그인), 조직 생성, 멤버 초대·수락·취소·만료·역할(API §10.1, 초대 메일 발송은 개발에서 로컬 메일함(Inbucket)/링크 복사)
- `security/` 모듈: authz, audit 헬퍼, idempotency 미들웨어, secrets(AES-GCM), 잡 워커(원자적 claim·리스 재수집·backoff·펜싱, DATABASE §6)
- **게이트**: **레이트 리밋 테스트**(동시 N요청에서 카운트 정확, 한도 초과 429·`Retry-After`, 윈도 경과 후 복구, 카운터 오류 시 공개=fail-closed/내부=fail-open), pgTAP로 타 조직 접근 0건, RLS 미적용 테이블 0개(린트), 비밀이 응답/로그에 나오지 않음, 감사 로그 append-only 검증(UPDATE/DELETE/TRUNCATE 거부, 중요 변경 롤백 시 감사 행도 롤백), 단위 테스트 통과, **잡 테스트**(동시 워커 2개가 같은 작업 중복 처리 0건, 리스 만료 `running` 재수집, 5회 후 `dead`, 오래된 워커의 늦은 완료 보고 폐기), **초대 테스트**(토큰 재사용 불가, 만료·취소 후 수락 불가, 이메일 불일치 거부, admin의 admin 초대 거부, 타 조직 초대 조회 불가, DB에 토큰 평문 없음)

### Phase 2C — 보안 마무리 (Phase 3 진입 전)
- CAPTCHA(Turnstile, 직접 GoTrue 호출 차단), 보안 헤더(CSP nonce·HSTS·Permissions-Policy, 개발/운영 분리), 관리자 MFA(TOTP, DB·API·UI 3중 강제) — 상세 ARCHITECTURE §6.8, DATABASE §3
- 검증: 실제 로컬 Supabase에서 `scripts/test-supabase.sh`(DB·API·GoTrue·CAPTCHA·MFA 146개 통과), `scripts/test-captcha-fail.sh`(토큰 검증 실패 경로 1개 통과), 스텁 환경 회귀(DB 77·API 50), 단위 47, 브라우저로 CAPTCHA 위젯·CSP 위반 없음·MFA 등록→2단계 로그인 확인
- 남은 위험은 ARCHITECTURE §6.8 "잔여 위험" 참조(계정 열거 잔존 등)

### Phase 3C-B — 웹 채팅 위젯
- `public/widget.js`(Shadow DOM·textContent 전용·쿠키 없음·ko/en·접근성·모바일 전체 화면), 위젯 생성/설정/출처 관리/일시중지, 설치 스니펫, 공개 식별자와 비밀(ID 검증 HMAC) 분리, SSE(+재연결·재개·폴링 폴백), 세션 만료·유휴·폐기·출처 재검증, 상담원 채팅 종료·방문자 온라인 표시. 마이그레이션 `20261112000007_widget.sql`.
- 검증: 실제 로컬 Supabase 전체 209(위젯 18 신규: 키·토큰의 관리자 API 접근 불가, 출처·일시중지·출처 제거 즉시 반영, ID 검증·회전, SSE 푸시/재개/`closed`/max_s, 만료·유휴·폐기·타 출처, 조직 간 격리·동시 8 방문자·동일 `client_id` 6중복, 제어문자·마크업·주입 문구 무해, 제한, 로그 무PII, 위젯 소스 정적 검사) + 단위 76, 브라우저 E2E(다른 출처 4010에서 설치 → 전송 → Inbox 실시간 → 답장 SSE 수신 → 서버 중단/재기동 재연결 → 상담원 종료 반영 → 360px iframe 실측, 겹침 버그 수정).
- **미검증/후속**: 실제 고객사 CSP/프록시/CDN 환경(SSE 버퍼링), Safari/Firefox 등 타 브라우저, 스크린리더 실사용·axe, 대규모 동시 스트림, 첨부·입력 중 표시·이력, AI 응대(Phase 4).

### Phase 3C-A — 운영 이메일
- 수신: 서명된 **원문 RFC 5322 웹훅**(기본 방식 결정·비교는 ARCHITECTURE §6.9) + 패키지 없는 MIME 파서(인코딩·multipart·문자셋·첨부 메타, HTML→텍스트), 스레딩 고도화(먼저 온 답장 합류, 같은 고객 한정), 수신 감사. 발신: SMTP TLS/STARTTLS/AUTH(인증서 항상 검증·다운그레이드 금지), 오류 분류(transient/permanent/uncertain), **불확실 결과는 자동 재시도 금지**, 결과·감사 원자 기록, `from_name`. 마이그레이션 `20261112000006_email_prod.sql`.
- 검증: 실제 TLS 인증서(openssl)로 SMTP 서버를 띄운 단위 테스트 11개(암묵 TLS/STARTTLS/AUTH PLAIN·LOGIN, 자체서명·호스트 불일치·다운그레이드·평문 자격증명 거부, 4xx/5xx/불확실), MIME 9개, 워커 예제 2개, 실제 로컬 Supabase 통합 14개(원문 서명·파싱·XSS·중복·동시성, 순서 뒤바뀐 스레딩, 타 고객 인용 주입 차단, 조직 간 비연결, 발송 성공/550/451/불확실/중복 잡, 로그·감사에 PII 없음) + 전체 회귀 191, 단위 76.
- **미검증/후속**: 실제 외부 SMTP 공급자·Cloudflare 런타임·실제 메일 클라이언트 MIME 변형, DKIM(공급자 의존), 첨부 바이트 저장·스캔, 고아 대화 병합, `auto_submitted`/자기 주소 처리 분기, IMAP.

### Phase 3B — 통합 Inbox (이메일·웹 채팅 1차)
- 채널 계정(이메일/웹 채팅, 비밀 암호화·1회 표시), 고객·대화·메시지·첨부 메타, 서명된 이메일 웹훅(HMAC+±5분, 이벤트·메시지 이중 중복 방지, 비동기 잡), 아웃바운드 SMTP 발송(재시도·실패 표시·수동 재시도), 웹 채팅 세션·메시지·폴링 API, Inbox UI(목록·상세·답장/내부 메모·배정·상태·우선순위·검색/필터·고객 패널, 모바일 단일 열), Realtime(JWT 구독, 재연결 시 재조회 + 30초 폴링 안전망). 마이그레이션 `20261112000005_inbox.sql`, 로컬 `[realtime] enabled=true`(+≈225MB).
- 검증: 실제 로컬 Supabase 전체 177개 통과(Inbox 19: 서명 위조/재전송/타 조직 비밀, 중복·동시 8건→1건, Message-ID 변형, 스레딩, 조직 격리·PostgREST 직접 쓰기 거부, 권한, 발송 재시도→failed→수동 재시도, 웹 채팅 토큰 범위/Origin/만료·유휴·폐기, 로그에 비밀·본문·주소 없음), 단위 54, 브라우저 E2E(채널 생성→서명 웹훅→Realtime 반영→배정/우선순위/상태→답장·발송 실패 표시), 360px는 DOM 복제 iframe으로 측정(가로 스크롤 없음).
- 이번에 발견·수정: CSP `connect-src`가 `wss:` Realtime 소켓을 차단, Realtime 구독이 익명 토큰으로 시작해 이벤트 0건(구독 전 `setAuth`), `text[] || 'literal'` PL/pgSQL 버그, 신규 테이블 RLS force 누락.
- **미구현·후속(3C 제안)**: 웹 채팅 위젯 JS/SSE, IMAP 인바운드, 첨부 파일 저장(Storage)·스캔, 고객 병합·고객 정보 편집 UI, 채널 비밀 회전·삭제, 답장이 부모보다 먼저 처리될 때의 스레드 병합, 방문자 대화 종료/상담원의 세션 폐기 UI, 대화 보존기간 잡(`purge_pii` 확장), 목록 페이지네이션 UI, 웹훅 실패 이벤트 재처리 UI, axe 점검, 실제 SMTP(TLS/AUTH)·실제 메일 파서 연동 검증.

### Phase 3A — 고객 온보딩
- 초대 이메일 발송(`adapters/mail`), 공개 초대 미리보기·계정 생성(`redeem`)·수락 UI(`/invite`), 운영자 고객사 발급(`/api/internal/customers`), 조직 화면(`/dashboard/orgs/[id]`: 멤버·초대 재발송/취소·조직명·역할 설명), 멤버 목록 RPC(`list_members`). 마이그레이션 `20261112000004_onboarding.sql`.
- 검증: 실제 로컬 Supabase `tests/real` 31개(온보딩 13 포함, 동시 redeem/accept·만료·취소·이메일 불일치·조직 격리·로그에 토큰/비밀번호 없음) + 전체 회귀 통과, SMTP 단위 1개, 브라우저 E2E(발급→메일→계정 설정→MFA 등록→조직 화면→초대·재발송·취소→만료 안내).
- 미검증/후속: 360px 실측·axe, SMTP TLS/AUTH 실서버, 계정 생성 감사 행, 조직 전환 UI(현재 목록→선택), 소유권 이전, 초대 만료 알림

### Phase 2D — 보안 최종화 (Phase 3 진입 전)
- 초대 전용 가입(GoTrue `enable_signup=false` + UI `NEXT_PUBLIC_SIGNUP_MODE`), 가입 경로 이메일 열거 차단, TOTP 재사용·세션 정책 조사 기록(ARCHITECTURE §6.8)
- 검증: `scripts/test-supabase.sh` 145개 통과(실제 로컬 Supabase), 타입체크·ESLint 통과, 브라우저로 로그인 화면(가입 버튼 없음)·MFA 등록·2단계 화면(코드란 비어 있음)·로그아웃 확인. 360px 실측과 axe 자동 검사는 미수행(브라우저 창 크기 조절 불가·axe 미도입).
- **운영 적용 전 미완료(완료로 표시하지 않음)**: [ ] 운영 Supabase CAPTCHA 시크릿 [ ] 실제 Turnstile 사이트 키·시크릿 [ ] HTTPS CSP 확인 [ ] HSTS 확인 [ ] 운영 Supabase 가입 비활성·MFA 설정 확인 [ ] 환경변수·Secret 노출 검사
- 제안(범위 밖): 초대 수락 온보딩(계정 자동 발급+비밀번호 설정 화면), 운영자 작업 감사 기록

### Phase 2B — 실환경 검증·정합화 (Phase 3 진입 전)
- 문서/구현 불일치 정리(멱등성 예외, 감사 허용 목록, 시스템 유지보수 vs 조직 작업, `reclaimed` 제거, 조직 설정 범위), CSRF Origin 검사, 최소 로그인 UI·앱 셸
- 실제 Supabase(GoTrue/PostgREST) 기반 교차 테넌트·권한·초대·API 통합 테스트 — 환경 제약으로 실행하지 못한 항목은 보고서에 미검증으로 명시
- **실행 결과(실제 로컬 Supabase: `supabase start` + `bash scripts/test-supabase.sh`)**: 마이그레이션 2개 적용, DB 69·API 46·GoTrue 실환경 6 테스트 통과, 브라우저로 로그인→대시보드→조직 생성→로그아웃 확인. 로컬 Postgres 스텁 환경(`test-db.sh`/`test-api.sh`)은 회귀용으로 유지.
- **GoTrue 관찰 사항(앱 코드 밖, 테스트에 기록)**: ① 이미 확인된 이메일로 `/auth/v1/signup` 호출 시 `422 user_already_exists` → 이메일 존재 여부 열거 가능(공개 anon 키로 접근). 완화안(후속): 가입을 초대/서버 경유로 제한하거나 CAPTCHA·강한 레이트 리밋 ② 리프레시 토큰: 직전 부모 토큰은 현재 토큰으로 응답, 더 오래된 토큰은 거부되지만 세션 패밀리는 폐기되지 않음.
- 미구현·후속: 조직 소유권 이전·조직 삭제, integrations/channel_accounts 감사 RPC(Phase 3), 조직별 보존기간 반영(Phase 3), MFA, 감사 재시도 잡

## Phase 3 — 통합 Inbox
- channel_accounts·customers·conversations·messages·attachments·`webhook_events` 마이그레이션(유니크 제약은 DATABASE §2.5·§10)
- 웹 채팅 위젯(방문자: 세션 토큰 + SSE/폴링, `chat_sessions` 마이그레이션; 상담원 화면: Realtime), 이메일 인바운드 웹훅 + SMTP 발송 어댑터
- Inbox UI(3열, 반응형), 배정·상태·내부 메모
- **게이트**: 웹훅 중복 전송·같은 Message-ID 재수신(대소문자/꺾쇠 차이 포함) 시 메시지·대화 각 1건, 두 조직이 같은 Message-ID를 받아도 각각 1건, 서명 실패·미등록 식별자는 `webhook_events` 0행, 다른 조직 비밀로 서명한 요청 거부, 메시지 충돌 시 고아 대화 0건, 방문자 토큰으로 타 대화 접근 불가·만료/폐기 토큰 거부·허용되지 않은 Origin 거부·세션/메시지 레이트 리밋 동작·내부 메모 미노출, 어댑터 계약 테스트 통과, 360px/데스크톱 및 키보드 E2E, 접근성 점검(axe) 오류 0

## Phase 4 — AI·지식·승인
- **구현 순서·현황·합의 필요 사항 초안: [AI-MODULES-PLAN.md](AI-MODULES-PLAN.md)** (P1 AI 초안 모드 → P2 지식 → P3 승인·도구 → P4 워크플로). 대시보드 해당 메뉴는 그때까지 "개발 중" 표시를 유지한다.
- `LlmProvider`(mock/ollama), 도구 레지스트리, PolicyGate, KB 수집·임베딩·검색, 에이전트 버전/모드
- Takeover/Handback, 승인 대기열 UI, Kill switch, `agent_version_kb_sources`(참조 무결성), `purge_pii` 잡
- **게이트**: `high` 도구는 승인 없이 실행 불가(자동 테스트), 승인 1건=실행 1회(동시 클릭·재시도 테스트), 승인 후 args 변조 시 거부, 프롬프트 인젝션 샘플로 권한 확대 불가, AI 답변 출처 표시, Takeover 즉시 AI 중지, 타 조직 KB 소스를 에이전트 버전에 연결 시 DB가 거부, 참조 중 KB 소스 하드 삭제 거부, 최종 상태 30일 후 `args` null·`payload_hash` 유지, 감사 로그 `metadata`에 PII/인자 원문 없음(테스트)

## Phase 5 — 워크플로·CRM·분석
- 워크플로 정의/실행/재시도, 고객 병합·필드, 분석 뷰·대시보드
- **게이트**: 워크플로 재시도 시 완료 스텝 재실행 0회, 분석 수치가 원천 데이터와 일치(샘플 검증), 조직 간 집계 격리

## Phase 6 — 하드닝·파일럿
- 부하 테스트(Inbox p95, 웹훅 버스트), 보존·삭제 잡, 백업/복구 리허설, 레이트 리밋 점검, 보안 리뷰(OWASP ASVS L1 체크리스트)
- 파일럿 1~2개 고객사, PRD 성공 지표 측정
- **게이트**: PRD §1 지표 달성 여부 리포트, 치명 이슈 0

## Phase 7+ — 확장(별도 승인)
- `VoiceAdapter` 구현(STT/TTS/SIP 공급자 선택 시 비용 검토 후 결정), IMAP 어댑터, 라이트 테마, 영어 i18n, 추가 커넥터

## 검증 원칙
1. RLS·승인·멱등성은 기능 구현 **전에** 실패하는 테스트부터 작성.
2. 각 Phase 종료 시 문서(API/DATABASE) 동기화 확인 후 완료 처리.
3. 문서와 구현이 다르면 구현을 임의로 두지 않고 문서 개정 PR을 먼저 한다.

## 위험과 대응
| 위험 | 대응 |
|---|---|
| LLM 환각으로 잘못된 안내 | KB 인용 필수, 출처 없으면 Handoff, 초기 `draft` 모드 |
| 프롬프트 인젝션 | 도구 권한 코드 고정, 입력은 데이터로 취급, 승인 게이트 |
| 무료 티어 한도 | 로컬 Supabase 개발, 사용량 `usage_events` 모니터링, 어댑터로 교체 가능 |
| 이메일 수신 신뢰성 | 웹훅 서명·멱등, IMAP 어댑터 후속 준비 |

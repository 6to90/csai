# API — 내부 API 및 외부 서비스 어댑터 명세

참조: [CLAUDE.md](CLAUDE.md) · [ARCHITECTURE.md](ARCHITECTURE.md) §3·§4·§6 · [DATABASE.md](DATABASE.md)

## 1. 공통 규칙
- Base: `/api/v1`. JSON. 인증: Supabase 세션(쿠키/Bearer JWT). 조직은 서버가 `memberships`로 결정하며 대상 조직은 `X-Org-Id`(uuid) 헤더로 선택하되 멤버십 검증 필수.
- **권한 표기**: `V`=viewer 이상, `A`=agent 이상, `M`=admin 이상(owner 포함), `O`=owner.
- 변경 요청(POST/PATCH/DELETE)은 `Idempotency-Key` 헤더 지원(웹훅·결정·발송 계열은 필수) → 같은 키 재요청 시 최초 응답 재생, 본문이 다르면 `422 idempotency_mismatch`.
- **멱등성 예외(비밀·토큰 응답)**: 응답에 일회성 토큰 등 비밀이 들어 있는 엔드포인트(`POST /org/invitations`, `POST /org/invitations/{id}/resend`)는 응답이 `idempotency_keys.response`에 저장되므로 **Idempotency-Key 재생을 적용하지 않는다**. 대신 자연 멱등성을 쓴다: `(org_id, email)` pending 부분 유니크로 중복 생성은 `409`. 재전송은 항상 **토큰을 새로 발급**(이전 토큰 즉시 무효화)하며 이전 응답을 재생하지 않는다. 토큰이 유실되면 `resend`로 재발급한다.
- **CSRF/Origin**: 쿠키 세션 인증 + 상태 변경(POST/PATCH/DELETE) 요청은 `Origin`(없으면 `Sec-Fetch-Site: same-origin`)이 앱 origin(`APP_URL`)과 일치해야 하며 아니면 `403`. `Authorization: Bearer` 요청은 암묵적 자격 증명이 아니므로 제외.
- 오류: `{ "error": { "code", "message", "request_id" } }`. 코드: `unauthorized 401`, `forbidden 403`, `not_found 404`(타 조직 리소스도 404), `validation_failed 422`, `conflict 409`, `rate_limited 429`, `internal 500`. 소유자·관리자 세션이 MFA(aal2)가 아니면 조직 엔드포인트는 `403 mfa_required`(DATABASE §3 MFA 규칙). 응답 보안 헤더(CSP·HSTS 등)는 ARCHITECTURE §6.8.
- 페이지네이션: `?limit=50&cursor=…` → `{ data, next_cursor }`.
- 모든 상태 변경은 `audit_logs` 기록(DATABASE §5). 레이트 리밋(저장소: Postgres `rate_limits`, DATABASE §2.5, ARCHITECTURE §6.7): 인증 사용자의 **변경 요청** 사용자당 120/min, 조직당 600/min; 공개 엔드포인트 IP·키별 30/min; 방문자 세션 20/min; 초대 등 개별 한도는 각 엔드포인트에 명시. 초과 시 `429` + `Retry-After`.

## 2. 공개 채팅 (위젯) — 인증: 방문자 세션 토큰 (정책: ARCHITECTURE §6.1)
| 메서드·경로 | 설명 |
|---|---|
| `POST /chat/sessions` | body `{ public_key, visitor_id, page_url? }` → `{ session_token(불투명 난수, 해시만 저장), conversation_id, expires_at }`. `Origin`이 허용 목록에 없으면 `403`. IP당 10/min |
| `POST /chat/sessions/{conversation_id}/messages` | `{ body }` (+`Idempotency-Key` 필수) → `{ message_id }`. 본문 ≤ 4,000자, 세션당 20/min, 첨부는 후속 |
| `GET /chat/sessions/{conversation_id}/stream` | **SSE**. `Last-Event-ID` 재개, 15초 하트비트, 연결 최대 55초 후 재연결 |
| `GET /chat/sessions/{conversation_id}/messages?after=` | **폴링 폴백**(SSE 불가 시). 토큰 스코프 대화의 공개 메시지만 반환 |
- 헤더 `Authorization: Bearer <session_token>`. 만료·폐기된 토큰은 `401`. 관리자·상담원 화면은 이 API를 쓰지 않고 Supabase Realtime을 사용한다.

## 3. Conversations (Unified Inbox) — `V` 조회, `A` 변경
- `GET /conversations?status=&channel=&assignee=&q=&cursor=`
- `GET /conversations/{id}` · `GET /conversations/{id}/messages`
- `POST /conversations/{id}/messages` `A` — `{ body, internal?: boolean, from_draft_id? }` 발송(멱등 키 필수)
- `PATCH /conversations/{id}` `A` — `{ status?, assignee_id?, tags? }`
- `POST /conversations/{id}/takeover` `A` — AI 중지(`ai_enabled=false`), 담당 지정
- `POST /conversations/{id}/handback` `A` — AI 재개

## 4. AI Agents — `V` 조회, `M` 변경
- `GET/POST /agents` · `GET/PATCH /agents/{id}` (`name, mode, enabled, channel_kinds`)
- `POST /agents/{id}/versions` — 새 불변 버전 생성 `{ system_prompt, tone, allowed_tools, kb_source_ids, params }`(`kb_source_ids`는 요청 형식일 뿐, 서버가 같은 조직 소스인지 검증한 뒤 `agent_version_kb_sources` 행으로 저장)
- `POST /agents/{id}/activate` — `{ version_id }` 활성화/롤백
- `POST /agents/{id}/test` `A` — `{ message }` → 응답·인용·제안 도구 호출(실제 실행·발송 없음, 드라이런)
- `POST /org/kill-switch` `M` — `{ enabled: boolean, reason }`

## 5. Knowledge Base — `V` 조회, `M` 변경
- `GET/POST /kb/sources` (`kind: text|url|file`; 파일은 서명 업로드 URL 발급 → 업로드 → `POST /kb/sources/{id}/index`)
- `PATCH/DELETE /kb/sources/{id}` · `POST /kb/sources/{id}/reindex`
- `POST /kb/search` `A` — `{ query, k≤10 }` → `[{ chunk_id, content, score, source_id }]`

## 6. Workflows — `V` 조회, `M` 변경
- `GET/POST /workflows` · `GET/PATCH /workflows/{id}` · `POST /workflows/{id}/versions` · `POST /workflows/{id}/activate`
- `POST /workflows/{id}/runs` `A` — 수동 실행 `{ trigger_key, input }`(멱등: 같은 `trigger_key`는 기존 run 반환)
- `GET /workflow-runs?workflow_id=&status=` · `GET /workflow-runs/{id}` (스텝 포함) · `POST /workflow-runs/{id}/cancel` `M`

스텝 정의(`workflow_versions.definition`): `{ trigger, steps:[{ key, type: 'ai_reply'|'assign'|'label'|'http_call'|'update_customer'|'request_approval', config, risk? }] }` — `risk`는 도구 레지스트리 값보다 낮출 수 없다.

## 7. Human Control — Approvals
- `GET /approvals?status=pending` `V`
- `GET /approvals/{id}` `V`
- `POST /approvals/{id}/decision` — 정책의 `approver_roles`, `Idempotency-Key` 필수. body `{ decision: 'approve'|'reject', note?, edited_args? }`. `edited_args`가 있으면 `payload_hash` 재계산. 요청한 AI/동일 주체 결정 시 `403`. 만료·이미 결정됨 `409`.
- `GET/PUT /approval-policies` `M` — 정책 목록/교체(`high`+`allow` 조합은 `422`)

## 8. Customers (CRM) — `V` 조회, `A` 변경
- `GET /customers?q=&tag=` · `GET /customers/{id}` · `PATCH /customers/{id}` (`display_name, tags, custom_fields`)
- `POST /customers/{id}/merge` `M` — `{ into_customer_id }`
- `DELETE /customers/{id}` `M` — 익명화 처리(DATABASE §8)

## 9. Analytics — `V`
- `GET /analytics/overview?from=&to=&channel=&agent_id=` → `{ conversations, first_response_p50, resolution_p50, ai_resolution_rate, handoff_reasons[], approvals:{ pending, avg_decision_seconds } }`
- `GET /analytics/timeseries?metric=&interval=day`

## 10. Integrations — `M`
- `GET/POST /channel-accounts` · `PATCH/DELETE /channel-accounts/{id}` (`web_chat` 생성 시 `public_key`·설치 스니펫 반환)
- `GET/POST /integrations` · `PATCH/DELETE /integrations/{id}` (`config.allowed_hosts` 포함)
- `PUT /integrations/{id}/secrets/{name}` — `{ value }` **쓰기 전용**. 응답 `{ name, last4, rotated_at }`. 조회 값 반환 엔드포인트 없음. `DELETE` 지원.
- `POST /integrations/{id}/test` — 연결 테스트(결과 요약만 반환)
- `GET /audit-logs?action=&actor=&from=&to=` — `M`, 읽기 전용

## 10.1 Organization · Members · Invitations
권한은 DATABASE §3 초대 RPC 규칙과 동일. 변경은 감사 로그를 기록하며(RPC 내부, 같은 트랜잭션), 토큰을 반환하는 초대 생성·재발송은 §1의 멱등성 예외를 따른다.
- `POST /orgs` — 로그인 사용자가 조직 생성(생성자=`owner`) `{ name, slug }`
- `GET /org` `V` · `PATCH /org` `M` — **Phase 2 범위: `name`, `data_retention_days`만 수정**(감사 RPC `update_organization`, 직접 UPDATE 권한은 회수됨). `slug`·`kill_switch`(Phase 4 전용 엔드포인트)·**소유권 이전·조직 삭제는 미구현**(후속: owner는 현재 강등·삭제 불가, 조직 삭제는 append-only 감사 로그와의 보존 정책 확정 후 별도 절차)
- `GET /org/members` `V`(owner/admin: 이메일 포함 전체, 그 외: 본인만) · `PATCH /org/members/{id}` `M`(`{ role }`, `owner` 변경·마지막 owner 제거 불가, admin은 agent/viewer만 조정) · `DELETE /org/members/{id}` `M`
- **초대**
  - `POST /org/invitations` `M` — `{ email, role: 'admin'|'agent'|'viewer' }`(`admin` 초대는 owner만). 응답 `{ id, email, role, expires_at }` + 메일 발송 어댑터가 없는 환경에서는 `accept_url`을 **이 응답에서 1회만** 반환. 중복 pending·기존 멤버는 `409`. 조직당 20/hour.
  - `GET /org/invitations?status=` `M` — 토큰·해시 미노출.
  - `POST /org/invitations/{id}/resend` `M` — 토큰 재발급(이전 해시 무효화)·만료 연장, `pending`만.
  - `POST /org/invitations/{id}/revoke` `M` — `pending`→`revoked`. 이미 수락·만료면 `409`.
  - `POST /invitations/preview` — **공개**, `{ token }` → `{ org_name, email, role, has_account, expires_at }`. 유효한 대기 초대만; 그 외(불일치·만료·취소·사용됨)는 모두 동일한 `404 invitation_invalid`. IP당 60/hour.
  - `POST /invitations/redeem` — **공개**. **신규 이메일 전용**이며 **메일함 소유 증명(코드) 후에만** 계정을 만든다. 초대 토큰만으로는 소유를 증명하지 못한다(링크를 본 관리자·제3자도 토큰을 가짐). 같은 본문 형태로 2단계: ① `{ token, password(10~128자) }` → `202 { code_sent:true, email_hint }` — 초대된 주소로 **8자리 1회용 확인 코드**를 메일 발송(응답에는 코드 없음, 계정은 만들지 않음; 발송 수단이 없으면 production에서 `503 mail_unavailable`로 실패-폐쇄). ② `{ token, password, code }` → `201 { email }` — 코드가 서버 비밀 기반 MAC(토큰·이메일·시간대에 바인딩, 15~30분 유효)과 일치할 때만 확인된 계정을 생성; 틀리거나 만료되면 `422 invalid_code`. 생성 이메일은 항상 DB의 초대 주소(요청값 무시). 이미 계정이 있으면 `409 account_exists`(메일 미발송, 비밀번호 불변), 무효·만료·사용된 토큰은 `404 invitation_invalid`. 토큰은 소비하지 않음(이후 로그인→`accept`가 만료·단일 사용·**확인된** 이메일 일치를 강제). 제한: IP당 20/hour, 토큰당 10/hour, 코드 발송 토큰당 3/hour·IP당 10/hour, 코드 시도 토큰당 5/hour(모두 fail-closed).
  - `POST /internal/customers` — **운영자 전용**(`Authorization: Bearer $CRON_SECRET`), `{ email, org_name, slug }` → 조직 생성 + 첫 `owner` 초대 메일 발송. 같은 (email, slug) 재호출은 링크 재발급(이전 링크 무효), 이미 소유자가 있는 조직·다른 이메일은 `409`.
  - 메일 발송: `MAIL_TRANSPORT` 설정 시 초대 생성·재발송 응답에 `mail_sent: true`만 있고 `accept_url`은 없다. 미설정 또는 발송 실패 시 `mail_sent: false` + `accept_url`(1회).
  - `POST /invitations/accept` — **로그인 사용자 전용**, `{ token }` → `{ org_id, role }`. 토큰 불일치·만료·폐기·이미 사용은 모두 동일한 `404 invitation_invalid`(상태 노출 방지). 로그인 이메일(인증 완료)이 초대 이메일과 다르면 `403 email_mismatch`. 일회성: 성공 1회 후 재사용 불가. IP·사용자당 10/hour.
  - 만료: 기본 7일, 수락 시 `expires_at` 검사 + 정리 잡.

## 10.2 Inbox (Phase 3B)
- `GET /channels` `M`(owner/admin) · `POST /channels` `M` — 이메일 `{ kind:'email', name, address, from_name?, smtp_url? }`(`smtp_url`: `smtps://u:p@host:465` · `smtp+starttls://u:p@host:587` · `smtp://host:25`(자격증명 불가); 허용 포트 25·465·587·2525; **호스트는 공인 주소여야 한다**: IP 리터럴/DNS 해석 결과(A·AAAA 전부)가 loopback·사설·링크 로컬·CGNAT·메타데이터(169.254.x)·멀티캐스트·예약 대역이면 `422 validation_failed`(저장·생성 없음), 발송 시점에 연결 주소를 다시 검증해 DNS 재바인딩도 차단. 운영자 옵트인 `SMTP_ALLOW_PRIVATE_HOSTS=1`은 기본 꺼짐·멀티테넌트 금지) → `{ id, webhook_path, webhook_secret }`(**서명 비밀은 이 응답에서만 1회**, 암호화 저장·재조회 불가, `smtp_url`도 쓰기 전용); 웹 채팅 `{ kind:'web_chat', name, allowed_origins[] }`(origin 형식만) → `{ id, public_key }`. `PATCH /channels/{id}` `{ status:'active'|'paused' }`. 모두 감사 로그. 비밀 회전·채널 삭제는 후속.
- `GET /conversations?status=&assignee=me|unassigned|<uuid>&priority=&unread=1&q=&limit=&before=` `V` — 고객 임베드, `last_message_at desc`. `q`는 제목·고객 이름/이메일 부분 일치(와일드카드·필터 문자는 제거).
- `GET /conversations/{id}` `V` — 대화 + 고객 + 채널 + 메시지(첨부 메타 포함, 내부 메모 포함). `PATCH /conversations/{id}` `A`(agent+) `{ status?, priority?, assignee_id? }`(assignee는 같은 조직 owner/admin/agent만, `null`=해제; 감사 `conversation.update`). `POST /conversations/{id}/read` `A`.
- `POST /conversations/{id}/messages` `A` — `{ body, client_id(uuid), internal? }`. **`client_id`가 멱등 키**: 같은 값 재요청은 `200 { duplicate:true }`로 기존 메시지 반환(중복 발송 없음). 이메일 채널 답장은 `queued`→잡이 SMTP 발송(`sent`/실패 시 재시도 후 `failed`), 웹 채팅은 즉시 `sent`, `internal`은 고객에게 가지 않음. 분당 60.
- `POST /messages/{id}/retry` `A` — `failed` 아웃바운드만 `queued`로(아니면 `409`).
- **이메일 웹훅** `POST /webhooks/email/{channel_account_id}` — **원문 모드**: `Content-Type: message/rfc822` 바디=RFC 5322 메시지(서명은 수신 바이트 기준, 파싱 불가/발신자 없음은 `422`, 저장 없음). JSON 모드는 아래. 헤더 `X-Signature-Timestamp`(unix 초, ±5분), `X-Signature` = hex(HMAC-SHA256(채널 비밀, `"{timestamp}.{원문 바디}"`)). 바디(strict JSON): `{ message_id?, in_reply_to?, references?[], from:{email,name?}, subject?, text, html?, date?, auto_submitted?, attachments?[{filename,mime?,size?}] }`. 응답 `200 { duplicate }`; 서명 실패 `401`(저장 없음), 미등록·일시중지 채널 `404`, 형식 오류 `422`(서명 통과 후에도 저장 없음). IP당 600/min. **본문 크기 상한 25 MiB는 실제로 수신한 바이트 기준으로 스트리밍 강제**(Content-Length 헤더만 믿지 않음): 상한 초과 시 읽기를 즉시 중단하고 `413 payload_too_large`, 형식이 잘못된 Content-Length는 `400`, 비밀 조회·서명 검증 전에 수행. 처리는 잡 `process_inbound`.
- **웹 채팅(방문자, 공개)** — `POST /chat/sessions` `{ public_key, visitor_id, name? }`(+`Origin`이 `allowed_origins`에 있어야 함, 아니면 `403`) → `{ token, conversation_id }`; `POST /chat/messages` `{ body(≤4000), client_id }`(Bearer 토큰, `client_id`로 중복 방지); `GET /chat/messages?after=<created_at>`(폴링; 방문자 본인 메시지와 **발송 완료된** 상담원/AI/시스템 응답만 — 내부 메모·초안·대기 중 메시지는 절대 미포함). 토큰은 불투명 난수(해시만 저장), 한 토큰=한 대화, 저장된 Origin과 다르면 `401`, 절대 24h/유휴 30분/폐기 시 `401`. SSE는 후속(현재 폴링).
- **스레딩**: 같은 고객의 메일만 연결, 부모보다 먼저 온 답장은 부모 도착 시 합류(ARCHITECTURE §6.9). 메시지 실패 코드(`error_code`): `smtp_4xx/5xx`, `auth_failed`, `tls_cert_invalid`, `starttls_unsupported`, `auth_requires_tls`, `no_transport`, `no_recipient`, `connect_refused`, `timeout`, **`uncertain_delivery`**(자동 재시도 없음).
- **웹 채팅 위젯(3C-B)**: `POST /channels`(web_chat) `{ name, allowed_origins[], title?, greeting?, color? }` → `{ id, public_key, identity_secret }`(비밀 1회). `PATCH /channels/{id}` `{ status?, name?, widget?:{allowed_origins?,title?,greeting?,color?} }`(감사, 출처 제거·일시중지는 기존 세션에 즉시 적용), `POST /channels/{id}/rotate-secret`(새 `identity_secret` 1회, 이전 것 즉시 무효). 공개: `GET /chat/config?public_key=`(허용 Origin에서만, 제목·인사말·색), `POST /chat/sessions`(+`email`,`email_hash` 선택; 틀리면 `403 identity_invalid`), `GET /chat/stream?after=&max_s=`(SSE `message`/`closed`, 최대 55초), `GET /chat/messages?after=`(폴링, `>=` 커서), `POST /chat/messages`, `POST /chat/end`(방문자가 자기 세션 종료). 상담원: `POST /conversations/{id}/end-chat`(agent+, 세션 폐기+대화 종료), `GET /conversations/{id}`에 `chat:{online,ended}`.
- **알려진 한계**: 서로 다른 고아 대화의 병합은 없다. 첨부는 메타데이터만 저장(파일 바이트·바이러스 검사 없음).

## 11. 웹훅 수신 (외부 → 시스템)
- `POST /webhooks/email/{channel_account_id}` — 인바운드 이메일. 서명 헤더(`X-Signature`: HMAC-SHA256(secret, raw body)+timestamp, 허용 오차 5분) 검증 실패 시 `401`. 성공 시 `webhook_events` 저장 후 **즉시 `200`**, 처리는 잡. 중복 `external_event_id`도 `200`.
- `POST /webhooks/{provider}/{integration_id}` — 향후 전화·외부 시스템 이벤트용 동일 규약. **조직은 항상 URL의 식별자(`channel_account_id`/`integration_id`)로 결정**하며 페이로드 내용으로 결정하지 않는다.
- **수신 처리 순서**(ARCHITECTURE §5.1): ① URL 식별자로 `channel_accounts`/`integrations` 조회(없으면 `404`, 저장 안 함) → 여기서 `org_id` 확정 ② 해당 조직의 서명 비밀 로드 ③ **원문 바디(raw body)** 로 HMAC·타임스탬프(±5분) 검증, 실패 시 `401` 후 **페이로드 저장 없이** 종료 ④ 통과 후에만 `webhook_events` INSERT(`on conflict do nothing`) ⑤ `200` 후 잡 처리. 서명 검증 실패는 IP 해시별 레이트 리밋(§1)으로만 제한(저장소 증폭 방지). 바디 최대 25MB.

## 12. 내부 엔드포인트 (공개 아님)
- `POST /api/internal/jobs/run` — 헤더 `Authorization: Bearer $CRON_SECRET`. 동작: reaper → 원자적 claim → 실행 → 펜싱 갱신(DATABASE §6). 응답 `{ claimed, done, retried, dead, lost, maintenance }`(`lost`=리스를 잃어 결과가 폐기된 건; `reclaimed`는 제공하지 않음 — 재수집 여부는 `jobs.attempts`와 감사 로그로 확인). 같은 호출에서 **시스템 유지보수 함수**(`expire_invitations`, `purge_rate_limits`, `purge_pii`)를 직접 실행한다(DATABASE §6.1).
- `GET /api/v1/health` — 인증 불필요, 비밀·버전 정보 미노출.

## 13. 어댑터 명세 (TypeScript, `src/server/adapters`)
```ts
// channels/types.ts
type InboundMessage = { externalId: string; threadId?: string; from: { kind: 'email'|'phone'|'chat_visitor'; value: string; name?: string };
  subject?: string; body: string; contentType: 'text'|'html'|'transcript'; attachments?: AttachmentRef[]; receivedAt: string };
type OutboundMessage = { conversationId: string; to: string; subject?: string; body: string; inReplyTo?: string };
type SendResult = { externalId: string };

// llm/types.ts
type LlmRequest = { system: string; messages: {role:'user'|'assistant'|'tool'; content:string}[];
  tools?: ToolSpec[]; responseFormat?: 'text'|'json'; maxTokens: number; timeoutMs: number };
type LlmResponse = { text?: string; toolCalls?: { name: string; args: unknown }[]; usage: { inputTokens: number; outputTokens: number } };

// tools/registry.ts — 위험도는 코드로 고정(AI·설정으로 낮출 수 없음)
type ToolSpec = { name: string; description: string; risk: 'low'|'medium'|'high'; argsSchema: ZodSchema;
  piiFields: string[];                 // 로그·요약·분석·감사에서 제외/마스킹할 인자 경로
  summarize(args): string;             // approval_requests.summary용, PII 최소화
  execute(ctx, args): Promise<unknown> };

// voice/types.ts (후속, 인터페이스만)
interface VoiceAdapter extends ChannelAdapter { kind: 'voice'; startCall(...): Promise<...>; onTranscript(cb): void; hangup(callId): Promise<void> }
```
- 어댑터 계약 테스트: 각 구현체는 동일 테스트 스위트(서명 검증 실패, 중복 이벤트, 타임아웃, 재시도 시 멱등)를 통과해야 한다.
- 어댑터는 비밀을 `secrets.get()`으로만 획득하고 로그에 출력하지 않는다.
- 도구 레지스트리 기본 도구: `kb.search`(low), `customer.lookup`(low), `conversation.label`(low), `customer.update`(medium), `http.call`(medium, 쓰기 메서드는 `high` 승격 가능 설정), `refund.create`(high, 외부 커넥터 연결 시).

## 14. 문서 간 대응표
| API 섹션 | 모듈(ARCHITECTURE §3) | 테이블(DATABASE §2) |
|---|---|---|
| §2·§3 | Unified Inbox | conversations, messages, channel_accounts, chat_sessions |
| §4 | AI Agents | ai_agents, agent_versions |
| §5 | Knowledge Base | kb_sources, kb_documents, kb_chunks |
| §6 | Workflow Engine | workflows, workflow_versions, workflow_runs, workflow_run_steps |
| §7 | Human Control | approval_policies, approval_requests, organizations.kill_switch |
| §8 | Customer CRM | customers, customer_identities |
| §9 | Analytics | v_conversation_metrics, usage_events |
| §10.1 | (횡단) Security | organizations, memberships, invitations |
| §10·§11 | Integrations | integrations, integration_secrets, webhook_events, audit_logs |

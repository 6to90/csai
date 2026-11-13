import Link from 'next/link';
import { Marks } from '@/components/Marks';
import { LinkButton, Pill } from '@/components/ui/controls';

export const metadata = { title: 'CSAI — 고객 문의를 하나로, 업무 처리는 AI와 함께' };

const NAV = [['기능', '#features'], ['보안', '#trust'], ['작동 방식', '#how'], ['가격', '#pricing']];

function Logo() {
  return <Link href="/" className="flex items-center gap-2 text-lg font-bold tracking-tight"><span aria-hidden className="grid size-7 place-items-center rounded-lg bg-[#0075de] text-sm text-white">C</span>CSAI</Link>;
}

function InboxMockup() {
  const rows = [
    ['김서연', '환불 문의드립니다', '주문번호 2291 결제 취소…', 'bg-[#f64932] text-white', '긴급'],
    ['Park J.', 'Shipping address change', 'Could you update the address…', 'bg-[#ffb110] text-black', 'AI 응답 대기'],
    ['이도윤', '세금계산서 재발행', '지난달 건 재발행 부탁드려요', 'bg-[#e6f3fe] text-[#0075de]', 'AI 초안'],
    ['최민아', '채팅: 배송 언제 오나요?', '내일 도착 예정입니다 :)', 'bg-[#e6f3fe] text-black/60', '해결됨'],
  ];
  return (
    <div aria-hidden className="mockup-shadow mx-auto grid max-w-5xl overflow-hidden rounded-xl border border-black/10 bg-white text-left md:grid-cols-[200px_1fr_1.1fr]">
      <div className="hidden border-r border-black/10 bg-[#f6f5f4] p-4 md:block">
        <div className="mb-4 text-sm font-semibold">Acme Store</div>
        {['개요', '통합 Inbox', 'AI 에이전트', '워크플로', '고객'].map((t, i) => <div key={t} className={`rounded-lg px-3 py-2 text-sm ${i === 1 ? 'bg-white font-medium' : 'text-black/55'}`}>{t}</div>)}
      </div>
      <div className="border-r border-black/10 p-3">
        {rows.map(([n, s, p, c, t], i) => (
          <div key={n} className={`rounded-lg p-3 ${i === 0 ? 'bg-[#f6f5f4]' : ''}`}>
            <div className="flex items-center justify-between gap-2"><b className="text-sm">{n}</b><span className={`rounded-full px-2 py-0.5 text-[11px] ${c}`}>{t}</span></div>
            <div className="truncate text-sm">{s}</div><div className="truncate text-xs text-black/55">{p}</div>
          </div>))}
      </div>
      <div className="flex flex-col gap-3 p-4">
        <div className="max-w-[85%] rounded-xl bg-[#f6f5f4] p-3 text-sm">안녕하세요, 주문번호 2291 환불 가능한가요?</div>
        <div className="ml-auto max-w-[85%] rounded-xl bg-[#02093a] p-3 text-sm text-white"><span className="mb-1 block text-xs text-white/60">AI 초안 미리보기 · 개발 중</span>확인해 보니 7일 이내 주문이라 환불이 가능합니다. 환불을 진행할까요?</div>
        <div className="rounded-lg border border-black/10 p-3 text-sm"><div className="mb-2 font-medium">승인 요청 예시: 환불 처리 ₩39,000</div><div className="flex gap-2"><span className="rounded-lg bg-[#0075de] px-3 py-1.5 text-white">승인</span><span className="rounded-lg border border-black/20 px-3 py-1.5">거절</span></div></div>
      </div>
    </div>
  );
}

const FEATURES = [
  { t: '통합 Inbox', d: '이메일과 웹 채팅을 한 화면에. 담당자 지정, 우선순위, 읽음 상태까지 팀이 함께 응대합니다.', s: '지금 사용 가능', bg: 'bg-[#ffb110] text-black', big: true },
  { t: 'AI 에이전트', d: '역할과 지식, 사용할 수 있는 도구를 정의한 AI가 답변 초안을 만들고 업무를 처리합니다.', s: '개발 중', bg: 'bg-[#02093a] text-white' },
  { t: '워크플로 자동화', d: '환불 조회, 일정 변경 같은 반복 업무를 단계별로 자동화합니다. 위험한 단계는 사람이 승인합니다.', s: '개발 중', bg: 'bg-[#62aef0] text-black' },
  { t: '사람 승인과 감사 로그', d: '위험도에 따라 승인 요청을 거치고, 모든 상태 변경은 지울 수 없는 감사 로그로 남습니다.', s: '감사 로그 적용 중', bg: 'bg-white text-black border border-black/10' },
];

export default function Home() {
  return (
    <div className="min-h-dvh bg-[#f6f5f4]">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-white focus:p-2">본문으로 건너뛰기</a>
      <header className="nav-shadow sticky top-0 z-40 bg-[#f6f5f4]/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-4 md:px-8">
          <Logo />
          <nav aria-label="주요" className="hidden gap-1 md:flex">{NAV.map(([l, h]) => <a key={h} href={h} className="rounded-lg px-4 py-3 text-sm text-black/55 hover:text-black">{l}</a>)}</nav>
          <div className="flex items-center gap-2"><LinkButton href="/login" variant="secondary" className="border-transparent">로그인</LinkButton><LinkButton href="/signup">시작하기</LinkButton></div>
        </div>
      </header>

      <nav aria-label="주요(모바일)" className="flex justify-center gap-1 border-b border-black/10 bg-[#f6f5f4] md:hidden">{NAV.map(([l, h]) => <a key={h} href={h} className="min-h-11 px-4 py-3 text-sm text-black/60">{l}</a>)}</nav>

      <main id="main">
        <section className="mx-auto max-w-[1440px] px-4 pb-20 pt-16 text-center md:px-8 md:pt-24">
          <Marks className="mb-8 justify-center" />
          <h1 className="display mx-auto max-w-4xl text-[40px] md:text-[72px]">
            고객 문의를 하나로,<br />업무 처리는 <span className="rounded-full bg-[#f6d5b8] px-4 md:px-6">AI</span>와 함께
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-[1.6] text-[#615d59]">이메일과 웹 채팅이 흩어져 있나요? CSAI는 모든 문의를 하나의 Inbox로 모으고, AI가 응대부터 업무 처리까지 맡되 위험한 행동은 반드시 사람의 승인을 거칩니다.</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3"><LinkButton href="/signup">무료로 시작하기</LinkButton><LinkButton href="#features" variant="ghost">기능 살펴보기</LinkButton></div>
          <div className="mt-16"><InboxMockup /><p className="mx-auto mt-4 max-w-xl text-center text-xs text-black/50">예시 화면입니다. 통합 Inbox는 지금 사용할 수 있고, AI 초안과 승인 요청은 개발 중인 기능의 미리보기입니다.</p></div>
        </section>

        <section className="mx-auto max-w-[1440px] px-4 pb-20 md:px-8" aria-label="지원 채널">
          <p className="mb-4 text-center text-sm text-black/40">하나의 Inbox로 연결되는 채널</p>
          <ul className="flex flex-wrap justify-center gap-x-12 gap-y-3 text-xl font-semibold text-black/60">
            <li>이메일</li><li>웹 채팅 위젯</li><li>전화 <span className="text-sm font-normal">(예정)</span></li>
          </ul>
        </section>

        <section id="features" className="mx-auto max-w-[1440px] scroll-mt-20 px-4 pb-20 md:px-8">
          <h2 className="display text-[36px] md:text-[54px]">상담팀에 필요한 것만, 한 곳에</h2>
          <p className="mt-3 max-w-xl text-lg text-[#615d59]">각 기능의 상태를 솔직하게 표시합니다.</p>
          <div className="mt-10 grid gap-4 md:grid-cols-6">
            {FEATURES.map((f) => (
              <article key={f.t} className={`rounded-xl p-6 md:p-8 ${f.bg} ${f.big ? 'md:col-span-6' : 'md:col-span-2'}`}>
                <Pill color="bg-white/90 text-black">{f.s}</Pill>
                <h3 className="mt-4 text-[22px] font-bold tracking-tight">{f.t}</h3>
                <p className={`mt-2 max-w-xl text-base ${f.bg.includes('text-white') ? 'text-white/80' : 'text-black/70'}`}>{f.d}</p>
              </article>))}
          </div>
        </section>

        <section id="trust" className="mx-auto max-w-[1440px] scroll-mt-20 px-4 pb-20 md:px-8" aria-labelledby="trust-h">
          <h2 id="trust-h" className="display text-[36px] md:text-[54px]">지금 적용되어 있는 보안</h2>
          <p className="mt-3 max-w-xl text-lg text-[#615d59]">구현된 항목만 적었습니다.</p>
          <ul className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {[['조직별 데이터 분리', '모든 업무 데이터는 조직 단위로 분리되고 DB 수준 정책(RLS)으로 강제됩니다.'], ['관리자 2단계 인증', '소유자·관리자는 인증 앱(TOTP) 확인이 필수이며 서버와 DB가 각각 확인합니다.'], ['초대 기반 가입', '초대 링크와 함께 초대받은 이메일로 보낸 확인 코드로 메일함 소유를 확인합니다.'], ['감사 로그', '설정·멤버·초대 변경은 삭제·수정할 수 없는 감사 로그로 기록됩니다.']].map(([t, d]) => (
              <li key={t} className="card p-6"><h3 className="text-lg font-bold tracking-tight">{t}</h3><p className="mt-2 text-sm text-[#615d59]">{d}</p></li>))}
          </ul>
        </section>

        <section id="how" className="mx-auto max-w-[1440px] scroll-mt-20 px-4 pb-20 md:px-8">
          <h2 className="display text-[36px] md:text-[54px]">작동 방식</h2>
          <ol className="mt-10 grid gap-4 md:grid-cols-3">
            {[['1', '채널 연결', '이메일 주소와 웹 채팅 위젯을 연결하면 문의가 하나의 대화로 모입니다.'], ['2', 'AI가 초안 작성', '지식과 정책에 맞춰 답변 초안과 필요한 업무를 제안합니다.'], ['3', '사람이 승인', '환불처럼 위험한 행동은 승인 후에만 실행되고 기록이 남습니다.']].map(([n, t, d]) => (
              <li key={n} className="card p-6"><span className="grid size-8 place-items-center rounded-full bg-[#e6f3fe] text-sm font-bold text-[#0075de]">{n}</span><h3 className="mt-4 text-[22px] font-bold tracking-tight">{t}</h3><p className="mt-2 text-[#615d59]">{d}</p></li>))}
          </ol>
        </section>

        <section id="pricing" className="mx-auto max-w-[1440px] scroll-mt-20 px-4 pb-20 md:px-8">
          <h2 className="display text-[36px] md:text-[54px]">가격</h2>
          <p className="mt-3 max-w-xl text-lg text-[#615d59]">현재는 초대 기반 베타입니다. 결제는 아직 연결되지 않았고, 정식 요금은 공개 전에 안내합니다.</p>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {[['Starter', '베타 무료', ['통합 Inbox', '이메일·웹 채팅 채널', '팀원 초대'], '시작하기', '/signup', true],
              ['Team', '곧 공개', ['AI 에이전트', '워크플로·승인', '고급 분석 리포트'], '로그인', '/login', false],
              ['Enterprise', '문의', ['전용 지원', '맞춤 연동', 'BYOK 모델 연결'], '로그인', '/login', false]].map(([n, p, items, cta, href, main]) => (
              <article key={n as string} className={`card flex flex-col p-6 ${main ? 'border-[#0075de]' : ''}`}>
                <h3 className="text-[22px] font-bold tracking-tight">{n as string}</h3><p className="mt-1 text-2xl font-semibold">{p as string}</p>
                <ul className="my-5 flex-1 space-y-2 text-[#615d59]">{(items as string[]).map((i) => <li key={i}>{main ? '✓' : '·'} {i}{main ? '' : <span className="ml-1.5 text-xs text-black/45">예정</span>}</li>)}</ul>
                <LinkButton href={href as string} variant={main ? 'primary' : 'ghost'}>{cta as string}</LinkButton>
              </article>))}
          </div>
        </section>

        <section className="mx-auto max-w-[1440px] px-4 pb-20 md:px-8">
          <div className="rounded-xl bg-[#02093a] p-8 text-center text-white md:p-16">
            <h2 className="display text-[32px] md:text-[54px]">오늘부터 한 곳에서 응대하세요</h2>
            <div className="mt-8 flex flex-wrap justify-center gap-3"><LinkButton href="/signup">시작하기</LinkButton><LinkButton href="/login" variant="ghost">로그인</LinkButton></div>
          </div>
        </section>
      </main>

      <footer className="border-t border-black/10">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-6 px-4 py-10 md:flex-row md:items-start md:justify-between md:px-8">
          <div className="max-w-sm"><Logo /><p className="mt-3 text-sm text-[#615d59]">고객 문의를 하나의 Inbox로 모으는 팀 운영 플랫폼. 현재는 초대 기반 베타입니다.</p></div>
          <nav aria-label="푸터" className="flex flex-wrap gap-x-8 gap-y-2 text-sm text-[#615d59]">{[['기능', '#features'], ['보안', '#trust'], ['가격', '#pricing'], ['로그인', '/login'], ['시작하기', '/signup']].map(([l, h]) => <a key={h} href={h} className="min-h-11 py-3 hover:text-black md:py-1">{l}</a>)}</nav>
        </div>
        <p className="border-t border-black/10 py-4 text-center text-xs text-black/50">© CSAI</p>
      </footer>
    </div>
  );
}

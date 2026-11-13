import { PageHeader } from '@/components/PageHeader';
import { LinkButton, Pill } from '@/components/ui/controls';
import { Section } from '@/components/ui/data';

/** Honest placeholder for modules that are not built yet: says so, lists what is planned (user-facing wording only), and what works today. */
export function ComingSoon({ title, desc, planned, now, link }: { title: string; desc: string; planned: string[]; now: string; link: { href: string; label: string } }) {
  return (
    <>
      <PageHeader title={title} desc={desc} action={<Pill color="bg-[#e6f3fe] text-[#004a8f]">개발 중 · 아직 사용할 수 없음</Pill>} />
      <div className="grid max-w-3xl gap-4">
        <Section title="예정된 기능" desc="출시 순서와 시기는 확정되지 않았습니다.">
          <ul className="divide-y divide-[var(--border)]">
            {planned.map((p) => (
              <li key={p} className="flex items-center justify-between gap-3 px-5 py-3 text-sm"><span>{p}</span><span className="shrink-0 rounded-full bg-black/5 px-2 py-0.5 text-xs text-[#615d59]">예정</span></li>))}
          </ul>
        </Section>
        <Section title="지금 할 수 있는 일">
          <div className="flex flex-wrap items-center justify-between gap-4 p-5">
            <p className="max-w-xl text-sm text-[#615d59]">{now}</p>
            <LinkButton href={link.href} variant="ghost" className="min-h-9">{link.label}</LinkButton>
          </div>
        </Section>
      </div>
    </>
  );
}

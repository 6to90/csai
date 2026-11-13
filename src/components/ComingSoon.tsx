import { PageHeader } from '@/components/PageHeader';
import { LinkButton, Pill } from '@/components/ui/controls';

/** Honest placeholder for modules with no backend yet: states what is NOT built, what is planned, and what already works nearby. */
export function ComingSoon({ title, desc, planned, needs, link }: { title: string; desc: string; planned: string[]; needs: string; link: { href: string; label: string } }) {
  return (
    <>
      <PageHeader title={title} desc={desc} action={<Pill>개발 중 · 아직 사용할 수 없음</Pill>} />
      <div className="grid gap-4 md:grid-cols-2">
        <section className="card p-6"><h2 className="text-[22px] font-bold tracking-tight">계획된 범위</h2><ul className="mt-3 list-disc space-y-1 pl-5 text-[#615d59]">{planned.map((p) => <li key={p}>{p}</li>)}</ul></section>
        <section className="rounded-xl bg-[#ffb110] p-6"><h2 className="text-[22px] font-bold tracking-tight">현재 상태</h2><p className="mt-3 text-black/80">{needs}</p><div className="mt-4"><LinkButton href={link.href} variant="secondary" className="bg-white/60">{link.label}</LinkButton></div></section>
      </div>
    </>
  );
}

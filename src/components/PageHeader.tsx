import type { ReactNode } from 'react';
import Link from 'next/link';

export interface Crumb { label: string; href?: string }

/** Page title block used by every dashboard page. `compact` is for full-height screens (Inbox). */
export function PageHeader({ title, desc, action, crumbs, compact = false }: { title: string; desc?: string; action?: ReactNode; crumbs?: Crumb[]; compact?: boolean }) {
  return (
    <header className={`flex flex-wrap items-end justify-between gap-3 ${compact ? 'mb-3' : 'mb-6'}`}>
      <div className="min-w-0">
        {crumbs?.length ? (
          <nav aria-label="상위 경로" className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-[#615d59]">
            {crumbs.map((c, i) => (
              <span key={c.label} className="flex items-center gap-1.5">
                {i > 0 && <span aria-hidden className="text-black/30">/</span>}
                {c.href ? <Link href={c.href} className="hover:underline">{c.label}</Link> : <span>{c.label}</span>}
              </span>))}
          </nav>) : null}
        <h1 className="display text-[24px] md:text-[28px]">{title}</h1>
        {desc && !compact && <p className="mt-1 max-w-2xl text-sm text-[#615d59]">{desc}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </header>
  );
}

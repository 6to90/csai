import type { ReactNode } from 'react';
import { LinkButton } from './controls';

// Flat fills only (DESIGN.md). Status colors come from the accent cast; contrast checked against black text.
const TONE: Record<string, string> = {
  open: 'bg-[#e6f3fe] text-[#004a8f]', pending_approval: 'bg-[#ffb110] text-black', waiting_customer: 'bg-[#f6d5b8] text-black',
  resolved: 'bg-[#dff3e4] text-[#14532d]', closed: 'bg-black/5 text-[#615d59]',
  active: 'bg-[#dff3e4] text-[#14532d]', paused: 'bg-[#f6d5b8] text-black', error: 'bg-[#fde2de] text-[#8a1c0e]',
  pending: 'bg-[#ffb110] text-black', accepted: 'bg-[#dff3e4] text-[#14532d]', revoked: 'bg-black/5 text-[#615d59]', expired: 'bg-black/5 text-[#615d59]',
};
export function StatusPill({ status, label }: { status: string; label: string }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[status] ?? 'bg-black/5 text-black'}`}>{label}</span>;
}

export function EmptyState({ title, desc, action }: { title: string; desc?: string; action?: { href: string; label: string } }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <p className="text-base font-semibold">{title}</p>
      {desc && <p className="max-w-sm text-sm text-[#615d59]">{desc}</p>}
      {action && <div className="mt-2"><LinkButton href={action.href} variant="ghost">{action.label}</LinkButton></div>}
    </div>
  );
}

/** Card with an optional title row (title + description on the left, action on the right). The one section container for every dashboard page. */
export function Section({ title, desc, action, children, className = '' }: { title?: string; desc?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-3">
          <div className="min-w-0"><h2 className="text-base font-semibold">{title}</h2>{desc && <p className="text-xs text-[#615d59]">{desc}</p>}</div>
          {action}
        </div>)}
      {children}
    </section>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-lg bg-black/[.06] ${className}`} />;
}

/** Key metric. Pass `delta` only for a change you actually computed — never a placeholder. */
export function StatCard({ label, value, desc, delta, hot = false }: { label: string; value: ReactNode; desc?: string; delta?: { text: string; tone?: 'up' | 'down' | 'flat' }; hot?: boolean }) {
  const dc = delta?.tone === 'up' ? 'text-[#14532d]' : delta?.tone === 'down' ? 'text-[#8a1c0e]' : 'text-[#615d59]';
  return (
    <div className={`rounded-xl border p-4 ${hot ? 'border-transparent bg-[#e6f3fe]' : 'border-[var(--border)] bg-white'}`}>
      <div className="text-sm text-black/60">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-2"><span className="text-[28px] font-semibold leading-tight tracking-tight tabular-nums">{value}</span>{delta && <span className={`text-xs font-medium ${dc}`}>{delta.text}</span>}</div>
      {desc && <div className="mt-0.5 text-xs text-[#615d59]">{desc}</div>}
    </div>
  );
}

export interface Col<T> {
  key: string; header: string; cell: (row: T) => ReactNode;
  align?: 'right';
  /** first column is the row title on mobile; 'hide' drops a column from the mobile card */
  hideOnMobile?: boolean;
  /** screen-reader-only header (e.g. an actions column) */
  srOnlyHeader?: boolean;
}

/** Table on md+, stacked cards on mobile. The first column is the row header (title). Handles loading and empty states. */
export function DataTable<T>({ columns, rows, rowKey, caption, empty, loading = false }: { columns: Col<T>[]; rows: T[]; rowKey: (row: T) => string; caption: string; empty?: ReactNode; loading?: boolean }) {
  if (loading) return <div role="status" aria-label="불러오는 중" className="grid gap-2 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}</div>;
  if (!rows.length) return <>{empty ?? <EmptyState title="표시할 항목이 없습니다" />}</>;
  const [first, ...rest] = columns;
  const th = 'px-5 py-2.5 font-medium';
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="border-b border-[var(--border)] bg-black/[.02] text-xs text-[#615d59]">
            <tr>{columns.map((c) => <th key={c.key} scope="col" className={`${th} ${c.align === 'right' ? 'text-right' : ''}`}>{c.srOnlyHeader ? <span className="sr-only">{c.header}</span> : c.header}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {rows.map((r) => (
              <tr key={rowKey(r)} className="hover:bg-black/[.02]">
                <th scope="row" className="px-5 py-2.5 font-medium">{first.cell(r)}</th>
                {rest.map((c) => <td key={c.key} className={`px-5 py-2.5 ${c.align === 'right' ? 'text-right tabular-nums' : 'text-[#615d59]'}`}>{c.cell(r)}</td>)}
              </tr>))}
          </tbody>
        </table>
      </div>
      <ul aria-label={caption} className="divide-y divide-[var(--border)] md:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)} className="px-4 py-3">
            <div className="font-medium">{first.cell(r)}</div>
            <dl className="mt-1 grid gap-1 text-sm">
              {rest.filter((c) => !c.hideOnMobile).map((c) => (
                <div key={c.key} className="flex items-center justify-between gap-3"><dt className="text-xs text-[#615d59]">{c.srOnlyHeader ? '' : c.header}</dt><dd className="min-w-0 text-right">{c.cell(r)}</dd></div>))}
            </dl>
          </li>))}
      </ul>
    </>
  );
}

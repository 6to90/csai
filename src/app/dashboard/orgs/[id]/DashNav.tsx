'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

export interface NavItem { href: string; label: string; icon: string; soon?: boolean; badge?: number }
export interface NavGroup { label: string; items: NavItem[] }

// Outline icons (24px grid, 1.6 stroke). Inline so no icon package is needed.
const ICON: Record<string, string> = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z',
  contact: 'M3 5h18v14H3zM8 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5 17c0-2 1.5-3 3-3s3 1 3 3M14 9h4M14 13h4',
  bot: 'M12 8V4H8M5 8h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM9 14v1M15 14v1',
  book: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v14H6.5A2.5 2.5 0 0 0 4 19.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
  flow: 'M5 4h4v4H5zM15 16h4v4h-4zM7 8v4a2 2 0 0 0 2 2h6a2 2 0 0 1 2 2',
  chart: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
  users: 'M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 20v-1a4 4 0 0 0-3-3.9M16 4.1a3.5 3.5 0 0 1 0 6.8',
  card: 'M2 6h20v12H2zM2 10h20',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  updown: 'M7 15l5 5 5-5M7 9l5-5 5 5',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6L6 18',
};
function Icon({ name, className = 'size-[18px]' }: { name: string; className?: string }) {
  return <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${className}`}><path d={ICON[name] ?? ''} /></svg>;
}

export function DashNav({ groups, orgName, role, email, switchable, footer, children }: { groups: NavGroup[]; orgName: string; role: string; email: string; switchable: boolean; footer: ReactNode; children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);       // mobile drawer
  const [menu, setMenu] = useState(false);       // org / account menu
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const dlg = useRef<HTMLDialogElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const all = groups.flatMap((g) => g.items);
  const isActive = (it: NavItem) => (it === all[0] ? path === it.href : path.startsWith(it.href));
  const current = all.find(isActive)?.label ?? '';
  const hits = all.filter((it) => it.label.toLowerCase().includes(q.trim().toLowerCase()));

  const openPalette = () => { setQ(''); setIdx(0); setMenu(false); dlg.current?.showModal(); };
  const go = (it?: NavItem) => { if (!it) return; dlg.current?.close(); setOpen(false); router.push(it.href); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  useEffect(() => {
    if (!menu) return;
    const out = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', out); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', out); document.removeEventListener('keydown', esc); };
  }, [menu]);

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[256px_1fr]">
      <aside id="side" className={`${open ? 'flex' : 'hidden'} flex-col border-r border-[var(--border)] bg-[#efeeec] max-md:fixed max-md:inset-x-0 max-md:top-12 max-md:z-20 max-md:h-[calc(100dvh-3rem)] md:sticky md:top-0 md:flex md:h-dvh`}>
        <div className="hidden items-center px-4 pb-1 pt-4 md:flex">
          <Link href="/dashboard" className="flex items-center gap-2 text-base font-bold tracking-tight"><span aria-hidden className="grid size-6 place-items-center rounded-md bg-[#0075de] text-xs text-white">C</span>CSAI</Link>
        </div>
        <div className="px-3 pb-2 pt-3 md:pt-2">
          <button type="button" onClick={openPalette} className="flex min-h-9 w-full items-center gap-2 rounded-lg border border-[var(--border)] bg-white/70 px-3 text-sm text-black/50 hover:bg-white">
            <Icon name="search" className="size-4" /><span className="flex-1 text-left">페이지 이동</span><kbd className="rounded bg-black/5 px-1.5 text-xs font-sans text-black/50">⌘K</kbd>
          </button>
        </div>
        <nav aria-label="대시보드" className="flex flex-1 flex-col gap-4 overflow-y-auto px-3 py-2">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="mb-1 px-2 text-xs font-medium text-black/45">{g.label}</div>
              <ul className="flex flex-col gap-0.5">
                {g.items.map((it) => (
                  <li key={it.href}>
                    <Link href={it.href} onClick={() => setOpen(false)} aria-current={isActive(it) ? 'page' : undefined}
                      className={`flex min-h-9 items-center gap-2.5 rounded-lg px-2 text-sm ${isActive(it) ? 'bg-black/[.07] font-medium text-black' : 'text-black/65 hover:bg-black/[.04] hover:text-black'}`}>
                      <Icon name={it.icon} />
                      <span className="flex-1">{it.label}</span>
                      {it.badge ? <span className="rounded-full bg-[#0075de] px-1.5 py-px text-[11px] font-medium text-white"><span className="sr-only">안 읽은 메시지 </span>{it.badge > 99 ? '99+' : it.badge}</span> : null}
                      {it.soon && <span className="rounded-full bg-black/[.06] px-2 py-px text-[11px] text-black/60">개발 중</span>}
                    </Link>
                  </li>))}
              </ul>
            </div>))}
        </nav>
        <div ref={menuRef} className="relative border-t border-[var(--border)] p-2">
          {menu && (
            <div role="menu" aria-label="조직과 계정" className="absolute inset-x-2 bottom-full mb-1 rounded-xl border border-[var(--border)] bg-white p-2 shadow-[0_4px_12px_rgba(0,0,0,.1)]">
              <div className="px-2 py-1.5"><div className="truncate text-sm font-semibold">{orgName}</div><div className="text-xs text-[#615d59]">{role}</div></div>
              {switchable && <Link role="menuitem" href="/dashboard?pick=1" onClick={() => { setMenu(false); setOpen(false); }} className="flex min-h-9 items-center rounded-lg px-2 text-sm hover:bg-black/5">조직 전환</Link>}
              <div className="mt-1 border-t border-[var(--border)] px-2 pt-2"><div className="mb-2 truncate text-xs text-[#615d59]">{email}</div>{footer}</div>
            </div>)}
          <button type="button" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left hover:bg-black/[.05]">
            <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-md bg-[#f6d5b8] text-sm font-semibold">{orgName.slice(0, 1).toUpperCase()}</span>
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{orgName}</span><span className="block text-xs text-[#615d59]">{role}</span></span>
            <Icon name="updown" className="size-4 text-black/40" />
          </button>
        </div>
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-12 items-center justify-between gap-3 bg-[#f6f5f4] px-3 md:px-10">
          <div className="flex min-w-0 items-center gap-1">
            <button type="button" aria-expanded={open} aria-controls="side" aria-label={open ? '메뉴 닫기' : '메뉴 열기'} onClick={() => setOpen(!open)} className="grid size-11 place-items-center rounded-lg hover:bg-black/5 md:hidden"><Icon name={open ? 'close' : 'menu'} /></button>
            <nav aria-label="현재 위치" className="flex min-w-0 items-center gap-2 text-sm"><span className="hidden truncate text-[#615d59] sm:inline">{orgName}</span><span aria-hidden className="hidden text-black/30 sm:inline">/</span><span className="truncate font-medium">{current}</span></nav>
          </div>
          <button type="button" onClick={openPalette} aria-label="페이지 이동 (⌘K)" className="grid size-11 place-items-center rounded-lg text-black/60 hover:bg-black/5 md:hidden"><Icon name="search" /></button>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto max-w-[1200px] p-4 pb-12 outline-none md:px-10 md:pt-6">{children}</main>
      </div>
      <dialog ref={dlg} aria-label="페이지 이동" onClick={(e) => { if (e.target === dlg.current) dlg.current?.close(); }}
        className="mt-[14vh] w-[min(520px,calc(100vw-2rem))] self-start justify-self-center rounded-xl border border-[var(--border)] bg-white p-0 text-[var(--text-primary)] shadow-[0_4px_12px_rgba(0,0,0,.1)] backdrop:bg-black/30">
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 focus-within:border-[#0075de]"><Icon name="search" className="size-4 text-black/40" />
          <input aria-label="이동할 페이지 검색" role="combobox" aria-expanded aria-controls="palette-list" aria-activedescendant={hits[idx] ? `pal-${idx}` : undefined} value={q} placeholder="이동할 페이지를 입력하세요" autoComplete="off"
            onChange={(e) => { setQ(e.target.value); setIdx(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(Math.min(idx + 1, hits.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(Math.max(idx - 1, 0)); }
              else if (e.key === 'Enter') { e.preventDefault(); go(hits[idx]); }
            }}
            className="min-h-12 flex-1 bg-transparent text-base bare-focus placeholder:text-black/40" /></div>
        <ul id="palette-list" role="listbox" aria-label="페이지" className="max-h-72 overflow-y-auto p-2">
          {hits.map((it, i) => (
            <li key={it.href} id={`pal-${i}`} role="option" aria-selected={i === idx} onMouseEnter={() => setIdx(i)} onClick={() => go(it)}
              className={`flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-3 text-sm ${i === idx ? 'bg-[#e6f3fe]' : ''}`}>
              <Icon name={it.icon} /><span className="flex-1">{it.label}</span>{it.soon && <span className="text-xs text-black/50">개발 중</span>}
            </li>))}
          {!hits.length && <li className="px-3 py-6 text-center text-sm text-[#615d59]">일치하는 페이지가 없습니다.</li>}
        </ul>
      </dialog>
    </div>
  );
}

'use client';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from './controls';

/** Confirm/cancel dialog on the native <dialog> (focus trap, Esc, inert background come from the platform). Controlled by `open`. */
export function Modal({ open, onClose, title, children, confirmLabel = '확인', cancelLabel = '취소', onConfirm, busy = false }: {
  open: boolean; onClose: () => void; title: string; children?: ReactNode;
  confirmLabel?: string; cancelLabel?: string; onConfirm?: () => void; busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const tid = useId();
  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} aria-labelledby={tid} onClose={() => { if (open) onClose(); }} onClick={(e) => { if (e.target === ref.current && !busy) onClose(); }}
      className="m-auto w-[min(440px,calc(100vw-2rem))] rounded-xl border border-[var(--border)] bg-white p-0 text-[var(--text-primary)] shadow-[0_4px_12px_rgba(0,0,0,.1)] backdrop:bg-black/30">
      <div className="p-5">
        <h2 id={tid} className="text-base font-semibold">{title}</h2>
        {children && <div className="mt-2 text-sm text-[#615d59]">{children}</div>}
      </div>
      <div className="flex justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
        <Button variant="ghost" className="min-h-9" disabled={busy} onClick={onClose}>{cancelLabel}</Button>
        {onConfirm && <Button className="min-h-9" disabled={busy} onClick={onConfirm}>{busy ? '처리 중…' : confirmLabel}</Button>}
      </div>
    </dialog>
  );
}

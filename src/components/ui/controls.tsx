import type { ButtonHTMLAttributes, InputHTMLAttributes } from 'react';
import Link from 'next/link';

// DESIGN.md: primary = the only filled blue; ghost = sky tint; secondary = hairline outline. 8px radius, >=44px touch target.
type Variant = 'primary' | 'ghost' | 'secondary';
const V: Record<Variant, string> = {
  primary: 'bg-[var(--accent)] text-white hover:bg-[#005bab]',
  ghost: 'bg-[#e6f3fe] text-[#0075de] hover:bg-[#d3e9fc]',
  secondary: 'border border-[var(--border-strong)] bg-transparent text-[var(--text-primary)] hover:bg-black/5',
};
const base = 'inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg px-4 text-sm font-medium disabled:opacity-60';

export function Button({ variant = 'primary', className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button {...p} className={`${base} ${V[variant]} ${className}`} />;
}
export function LinkButton({ href, variant = 'primary', className = '', children }: { href: string; variant?: Variant; className?: string; children: React.ReactNode }) {
  return <Link href={href} className={`${base} ${V[variant]} ${className}`}>{children}</Link>;
}
export function Field({ label, id, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: string; id: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-[var(--text-secondary)]">{label}</label>
      <input id={id} {...p} className="min-h-11 rounded-lg border border-[var(--border-strong)] bg-white px-3 text-[var(--text-primary)] placeholder:text-[var(--text-muted)]" />
    </div>
  );
}
export function Pill({ children, color = 'bg-[#f6d5b8] text-black' }: { children: React.ReactNode; color?: string }) {
  return <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${color}`}>{children}</span>;
}

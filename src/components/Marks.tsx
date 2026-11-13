// Decorative character marks (DESIGN.md "Avatar Character Mark"): flat face in a 2px colored ring. Shared by the landing hero and the auth panel.
// Static class names (Tailwind must see them); inline style attributes are blocked by the app CSP.
const RING = ['border-[#097fe8]', 'border-[#f64932]', 'border-[#ffb110]', 'border-[#62aef0]', 'border-[#097fe8]', 'border-[#f64932]', 'border-[#ffb110]'];
const DELAY = ['', '[animation-delay:250ms]', '[animation-delay:500ms]', '[animation-delay:750ms]', '[animation-delay:1000ms]', '[animation-delay:1250ms]', '[animation-delay:1500ms]'];

export function Marks({ small = false, className = '' }: { small?: boolean; className?: string }) {
  return (
    <div aria-hidden className={`flex gap-2 md:gap-3 ${className}`}>
      {RING.map((c, i) => (
        <span key={i} className={`bob grid place-items-center rounded-full border-2 bg-white ${small ? 'size-8' : 'size-11'} ${c} ${DELAY[i]}`}>
          <svg viewBox="0 0 24 24" className={small ? 'size-4' : 'size-6'}><circle cx="9" cy="10" r="1.3" fill="#000" /><circle cx="15" cy="10" r="1.3" fill="#000" /><path d="M8 15c1.2 1.6 6.8 1.6 8 0" stroke="#000" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg>
        </span>))}
    </div>
  );
}

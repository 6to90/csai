'use client';
import type { ReactNode } from 'react';

// 모듈 단위 ref 콜백: 마운트 시 한 번만 오른쪽 끝(최신 날짜)으로 스크롤. SSR 시에는 실행되지 않는다.
const toEnd = (el: HTMLDivElement | null) => { if (el) el.scrollLeft = el.scrollWidth; };

export function ScrollEnd({ label, children }: { label: string; children: ReactNode }) {
  return <div ref={toEnd} className="overflow-x-auto" tabIndex={0} role="group" aria-label={label}>{children}</div>;
}

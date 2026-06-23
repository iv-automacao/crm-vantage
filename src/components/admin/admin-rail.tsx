'use client';

import { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';
import {
  ADMIN_RAIL_GROUPS,
  ADMIN_SECTION_META,
  ADMIN_SECTIONS,
  type AdminSection,
} from './admin-sections';

// Largura mínima para o rail ser coluna vertical (espelha breakpoint `lg:`).
const RAIL_DESKTOP_MIN_PX = 1024;

/**
 * Rail de navegação do painel admin — agrupado, vertical no desktop e
 * scroll horizontal em telas menores. Espelha o comportamento do SettingsRail.
 */
export function AdminRail({
  active,
  onSelect,
}: {
  active: AdminSection;
  onSelect: (s: AdminSection) => void;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);

  // No mobile (rail horizontal), mantém o item ativo visível.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia(`(min-width: ${RAIL_DESKTOP_MIN_PX}px)`).matches) return;
    activeRef.current?.scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: 'smooth',
    });
  }, [active]);

  return (
    <nav
      aria-label="Seções do painel admin"
      className={cn(
        'flex gap-1 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        'border-b border-border',
        'lg:sticky lg:top-0 lg:flex-col lg:overflow-visible lg:border-b-0 lg:pb-0',
      )}
    >
      {ADMIN_RAIL_GROUPS.map(({ label, group }) => {
        const items = ADMIN_SECTIONS.filter(
          (s) => ADMIN_SECTION_META[s].group === group,
        );
        return (
          <div
            key={group}
            className="flex shrink-0 gap-1 lg:flex-col lg:gap-0.5"
          >
            {label ? (
              <div className="hidden px-3 pt-3.5 pb-1.5 text-[11px] font-semibold tracking-[0.09em] text-muted-foreground uppercase lg:block">
                {label}
              </div>
            ) : null}
            {items.map((s) => {
              const meta = ADMIN_SECTION_META[s];
              const Icon = meta.icon;
              const isActive = s === active;
              return (
                <button
                  key={s}
                  ref={isActive ? activeRef : undefined}
                  type="button"
                  onClick={() => onSelect(s)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium whitespace-nowrap transition-colors',
                    'lg:w-full',
                    isActive
                      ? 'bg-primary-soft text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="flex-1">{meta.label}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

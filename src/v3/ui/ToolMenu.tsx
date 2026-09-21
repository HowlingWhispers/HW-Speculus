import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type PopoverElement = HTMLDivElement & {
  showPopover?: () => void;
  hidePopover?: () => void;
  matches: (selector: string) => boolean;
};

const supportsPopover = () =>
  typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

export function ToolMenu({ label, children }: { label: string; children: ReactNode }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<PopoverElement>(null);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const nativePopover = supportsPopover();

  const position = () => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;

    const margin = 8;
    const gap = 6;
    const triggerRect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const maxWidth = Math.max(160, Math.min(280, viewportWidth - margin * 2));

    panel.style.maxWidth = `${maxWidth}px`;
    panel.style.maxHeight = `${Math.max(120, viewportHeight - margin * 2)}px`;

    requestAnimationFrame(() => {
      const panelRect = panel.getBoundingClientRect();
      const panelWidth = Math.min(panelRect.width || 190, maxWidth);
      const panelHeight = Math.min(panelRect.height || 220, viewportHeight - margin * 2);
      const left = Math.min(
        Math.max(margin, triggerRect.left),
        Math.max(margin, viewportWidth - panelWidth - margin),
      );
      const above = triggerRect.top - panelHeight - gap;
      const below = triggerRect.bottom + gap;
      const top = above >= margin
        ? above
        : Math.min(below, Math.max(margin, viewportHeight - panelHeight - margin));

      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(Math.max(margin, top))}px`;
    });
  };

  const close = () => {
    const panel = panelRef.current;
    if (nativePopover && panel?.hidePopover) {
      try { panel.hidePopover(); } catch { /* already closed */ }
    }
    setFallbackOpen(false);
  };

  const toggle = () => {
    const panel = panelRef.current;
    if (!panel) return;

    if (nativePopover && panel.showPopover && panel.hidePopover) {
      if (panel.matches(':popover-open')) {
        panel.hidePopover();
      } else {
        panel.showPopover();
        position();
      }
      return;
    }

    setFallbackOpen((open) => {
      const next = !open;
      if (next) requestAnimationFrame(position);
      return next;
    });
  };

  useEffect(() => {
    const panel = panelRef.current;
    if (nativePopover && panel) panel.setAttribute('popover', 'auto');

    const reposition = () => {
      if (nativePopover) {
        if (panel?.matches(':popover-open')) position();
      } else if (fallbackOpen) {
        position();
      }
    };

    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [fallbackOpen, nativePopover]);

  const panel = (
    <div
      ref={panelRef}
      className={`v2-tool-popover${fallbackOpen ? ' v2-tool-popover--fallback-open' : ''}`}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button')) close();
      }}
    >
      {children}
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="v2-tool-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={nativePopover ? undefined : fallbackOpen}
        onClick={toggle}
      >
        {label}
      </button>
      {nativePopover ? panel : fallbackOpen ? createPortal(panel, document.body) : null}
    </>
  );
}

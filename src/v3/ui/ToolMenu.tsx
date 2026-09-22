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
    const visualViewport = window.visualViewport;
    const viewportLeft = visualViewport?.offsetLeft ?? 0;
    const viewportTop = visualViewport?.offsetTop ?? 0;
    const viewportWidth = visualViewport?.width ?? document.documentElement.clientWidth;
    const viewportHeight = visualViewport?.height ?? document.documentElement.clientHeight;
    const viewportRight = viewportLeft + viewportWidth;
    const viewportBottom = viewportTop + viewportHeight;
    const maxWidth = Math.max(0, Math.min(280, viewportWidth - margin * 2));
    const maxHeight = Math.max(0, viewportHeight - margin * 2);

    panel.style.maxWidth = `${maxWidth}px`;
    panel.style.maxHeight = `${maxHeight}px`;

    requestAnimationFrame(() => {
      const panelRect = panel.getBoundingClientRect();
      const panelWidth = Math.min(panelRect.width || 190, maxWidth);
      const panelHeight = Math.min(panelRect.height || 220, maxHeight);
      const minLeft = viewportLeft + margin;
      const maxLeft = Math.max(minLeft, viewportRight - panelWidth - margin);
      const left = Math.min(Math.max(minLeft, triggerRect.left), maxLeft);
      const minTop = viewportTop + margin;
      const maxTop = Math.max(minTop, viewportBottom - panelHeight - margin);
      const above = triggerRect.top - panelHeight - gap;
      const below = triggerRect.bottom + gap;
      const top = above >= minTop ? above : Math.min(Math.max(minTop, below), maxTop);

      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(top)}px`;
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
    if (nativePopover) {
      const panel = panelRef.current;
      if (!panel?.showPopover || !panel.hidePopover) return;
      if (panel.matches(':popover-open')) {
        panel.hidePopover();
      } else {
        panel.showPopover();
        position();
      }
      return;
    }

    // The fallback panel does not exist until fallbackOpen becomes true.
    // Never require panelRef.current before opening it.
    setFallbackOpen((open) => !open);
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

    if (!nativePopover && fallbackOpen) requestAnimationFrame(position);
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

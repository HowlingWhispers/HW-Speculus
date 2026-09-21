import { createRoot } from 'react-dom/client';
import { V2DetachedTranscript } from './DetachedTranscript';

type DocumentPictureInPictureApi = {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  window?: Window | null;
};

type WindowWithDocumentPiP = Window & {
  documentPictureInPicture?: DocumentPictureInPictureApi;
};

export const supportsFloatingReader = () =>
  typeof window !== 'undefined' &&
  Boolean((window as WindowWithDocumentPiP).documentPictureInPicture?.requestWindow);

const detachedReaderUrl = (sessionId: string) => {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('display', sessionId);
  return url;
};

export function openSideReader(sessionId: string, targetPrefix: string) {
  const url = detachedReaderUrl(sessionId);
  const display = window.screen as Screen & { availLeft?: number; availTop?: number };
  const availLeft = display.availLeft ?? 0;
  const availTop = display.availTop ?? 0;
  const availWidth = display.availWidth || window.innerWidth;
  const availHeight = display.availHeight || window.innerHeight;
  const width = Math.min(520, Math.max(340, Math.round(availWidth * 0.3)));
  const height = Math.min(availHeight, Math.max(520, window.outerHeight || 760));

  const rightOfMain = window.screenX + window.outerWidth;
  const leftOfMain = window.screenX - width;
  const rightFits = rightOfMain + width <= availLeft + availWidth;
  const left = rightFits
    ? rightOfMain
    : Math.max(availLeft, Math.min(leftOfMain, availLeft + availWidth - width));
  const top = Math.max(
    availTop,
    Math.min(window.screenY, availTop + Math.max(0, availHeight - height)),
  );

  const target = `${targetPrefix}-${sessionId.replace(/[^a-z0-9_-]+/gi, '-')}`;
  return window.open(
    url.toString(),
    target,
    `popup=yes,width=${width},height=${height},left=${Math.round(left)},top=${Math.round(top)},resizable=yes,scrollbars=yes`,
  );
}

function copyReaderStyles(targetDocument: Document) {
  for (const node of document.querySelectorAll('style, link[rel="stylesheet"]')) {
    targetDocument.head.appendChild(node.cloneNode(true));
  }
}

export async function openFloatingReader(sessionId: string) {
  const api = (window as WindowWithDocumentPiP).documentPictureInPicture;
  if (!api?.requestWindow) {
    throw new Error('Always-on-top floating reader is not supported by this browser.');
  }

  const pipWindow = await api.requestWindow({ width: 520, height: 720 });
  copyReaderStyles(pipWindow.document);
  pipWindow.document.title = 'Speculus | Floating Reader';
  pipWindow.document.documentElement.className = document.documentElement.className;
  pipWindow.document.body.replaceChildren();

  const mount = pipWindow.document.createElement('div');
  mount.id = 'speculus-floating-reader-root';
  pipWindow.document.body.appendChild(mount);

  const root = createRoot(mount);
  root.render(
    <V2DetachedTranscript
      sessionId={sessionId}
      hostWindow={pipWindow}
      hostDocument={pipWindow.document}
    />,
  );

  pipWindow.addEventListener('pagehide', () => root.unmount(), { once: true });
  return pipWindow;
}

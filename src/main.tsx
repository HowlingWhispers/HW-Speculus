// V4 is the default runtime; legacy runtimes remain on explicit routes.
const path = window.location.pathname;
if (path === '/v1' || path.startsWith('/v1/')) {
  void import('./v1-entry');
} else if (path === '/v2' || path.startsWith('/v2/')) {
  void import('./v2/main');
} else if (path === '/v3' || path.startsWith('/v3/')) {
  void import('./v3/main');
} else {
  void import('./v4/main');
}

export {};

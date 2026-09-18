// Load only the selected engine. V2 stays stable; V3 is an isolated experimental fork built from the V2 baseline.
const path = window.location.pathname;
if (path === '/v3' || path.startsWith('/v3/')) {
  void import('./v3/main');
} else if (path === '/v2' || path.startsWith('/v2/')) {
  void import('./v2/main');
} else {
  void import('./v1-entry');
}

export {};

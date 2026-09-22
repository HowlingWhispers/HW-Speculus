// V3 is the current Speculus runtime. V1 and V2 remain available only on
// explicit legacy routes and are not part of normal development.
const path = window.location.pathname;
if (path === '/v1' || path.startsWith('/v1/')) {
  void import('./v1-entry');
} else if (path === '/v2' || path.startsWith('/v2/')) {
  void import('./v2/main');
} else {
  void import('./v3/main');
}

export {};

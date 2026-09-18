// Load only the selected engine. V1 experiments, CSS and storage never boot in V2.
const path = window.location.pathname;
if (path === '/v2' || path.startsWith('/v2/')) {
  void import('./v2/main');
} else {
  void import('./v1-entry');
}

export {};

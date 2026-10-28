// Auth session storage using the browser's localStorage.
// The Lovable preview broker has been removed; sessions persist normally.
export function brokeredPreviewStorage() {
  if (typeof window === 'undefined') return undefined;
  return localStorage;
}

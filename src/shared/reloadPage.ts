/** Reload the page. A function of its own so tests can stand in for it (jsdom cannot navigate). */
export function reloadPage(): void {
  window.location.reload();
}

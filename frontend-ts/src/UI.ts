/** Typed getElementById that fails loudly instead of returning null. */
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Missing element #${id}`);
    return node as T;
  }
  
  /** Escape text before putting it into innerHTML (stops HTML injection). */
  export function esc(value: string | number): string {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  
  export function toast(message: string, kind: 'ok' | 'err' = 'ok'): void {
    const note = document.createElement('div');
    note.className = `toast ${kind}`;
    note.textContent = message;
    $('toasts').appendChild(note);
    window.setTimeout(() => note.remove(), 3500);
  }
  
  export function setBusy(button: HTMLButtonElement, busy: boolean, label: string): void {
    button.disabled = busy;
    button.textContent = label;
  }
  
  export function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : 'Something went wrong';
  }
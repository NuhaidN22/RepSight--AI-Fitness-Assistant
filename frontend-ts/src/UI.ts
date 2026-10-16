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

/** Switch tab by clicking its nav button (keeps main.ts as the single owner of tab state). */
export function goTab(id: string): void {
  document.querySelector<HTMLButtonElement>(`#nav [data-t="${id}"]`)?.click();
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    toast("Couldn't copy. Select the text and copy it manually.", 'err');
  }
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
}

/** Themed replacement for window.confirm. Resolves true only if the user presses the confirm button. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'modal';

    const form = document.createElement('form');
    form.method = 'dialog'; // submitting closes the dialog and sets returnValue to the pressed button's value

    const title = document.createElement('h3');
    title.textContent = options.title;
    const message = document.createElement('p');
    message.className = 'mut';
    message.textContent = options.message;

    const row = document.createElement('div');
    row.className = 'row end';
    const cancel = document.createElement('button');
    cancel.className = 'btn-soft';
    cancel.value = 'cancel';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.className = 'btn-primary';
    ok.value = 'ok';
    ok.textContent = options.confirmLabel ?? 'Delete';

    row.append(cancel, ok);
    form.append(title, message, row);
    dialog.append(form);

    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'ok'); // Esc or Cancel gives anything but "ok"
      dialog.remove();
    });
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

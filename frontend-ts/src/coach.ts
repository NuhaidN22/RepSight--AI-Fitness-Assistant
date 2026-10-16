import { streamCoach } from './api';
import { ICONS } from './icons';
import { $, copyText, esc, messageOf } from './ui';

const SUGGESTIONS = [
  'Why is my squat stalling?',
  'Plan my next workout',
  'How did my week go?',
  'What should I work on to improve my form?',
];

const EMPTY_HTML = `
  <div class="chat-empty" id="chat-empty">
    <div class="coach-avatar big">${ICONS.bot}</div>
    <h3>What do you want to work on?</h3>
    <p class="mut">Ask a question, or start with one of these.</p>
    <div class="suggest">
      ${SUGGESTIONS.map((s) => `<button type="button" class="chip-btn" data-q="${esc(s)}">${esc(s)}</button>`).join('')}
    </div>
  </div>`;

const TEMPLATE = `
  <div class="page-head">
    <h2>AI Coach</h2>
    <p class="mut">Ask about your training, form and progress. Answers are based on the data you have logged.</p>
  </div>

  <div class="card coach-card">
    <div class="chat-head">
      <div class="coach-avatar">${ICONS.bot}</div>
      <div class="chat-title">
        <b>Your coach</b>
        <span class="status" id="coach-status"><i></i><em>Ready</em></span>
      </div>
      <button class="btn-ghost" id="clear-chat" type="button">Clear chat</button>
    </div>

    <div class="chat" id="chat" role="log" aria-live="polite">${EMPTY_HTML}</div>
    <button class="jump" id="jump" type="button" hidden>${ICONS.arrowDown} New messages</button>

    <form class="composer" id="chat-form">
      <textarea id="q" rows="1" maxlength="1000" placeholder="Why is my squat stalling?" aria-label="Message your coach"></textarea>
      <button class="send" id="send" type="submit" aria-label="Send" disabled>${ICONS.send}</button>
    </form>
    <p class="mut small foot">Coaching suggestions, not medical advice. Enter to send, Shift+Enter for a new line.</p>
  </div>
`;

interface Message {
  row: HTMLElement;
  bubble: HTMLElement;
  body: HTMLElement;
}

let streaming = false;
let controller: AbortController | null = null;

/* ---------- Scrolling ---------- */

const nearBottom = (): boolean => {
  const chat = $('chat');
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
};

function scrollDown(): void {
  const chat = $('chat');
  chat.scrollTo({ top: chat.scrollHeight });
  $('jump').hidden = true;
}

/* ---------- Messages ---------- */

function addMessage(role: 'user' | 'coach'): Message {
  $('chat-empty')?.remove();
  const row = document.createElement('div');
  row.className = `msg ${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const body = document.createElement('div');
  body.className = 'text';
  bubble.appendChild(body);

  if (role === 'coach') {
    const avatar = document.createElement('div');
    avatar.className = 'avatar-sm';
    avatar.innerHTML = ICONS.bot;
    row.append(avatar, bubble);
  } else {
    row.append(bubble);
  }
  $('chat').appendChild(row);
  scrollDown();
  return { row, bubble, body };
}

function addTool(reply: Message, label: string, onClick: () => void): void {
  let tools = reply.bubble.querySelector('.msg-tools');
  if (!tools) {
    tools = document.createElement('div');
    tools.className = 'msg-tools';
    reply.bubble.appendChild(tools);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tool';
  button.textContent = label;
  button.addEventListener('click', onClick);
  tools.appendChild(button);
}

function setStreaming(on: boolean): void {
  streaming = on;
  const send = $<HTMLButtonElement>('send');
  send.innerHTML = on ? ICONS.stop : ICONS.send;
  send.setAttribute('aria-label', on ? 'Stop' : 'Send');
  const status = $('coach-status');
  status.dataset.busy = String(on);
  const label = status.querySelector('em');
  if (label) label.textContent = on ? 'Thinking…' : 'Ready';
  updateSend();
}

function updateSend(): void {
  // While streaming the button is a Stop button, so it must stay enabled.
  $<HTMLButtonElement>('send').disabled = !streaming && $<HTMLTextAreaElement>('q').value.trim() === '';
}

function autosize(): void {
  const box = $<HTMLTextAreaElement>('q');
  box.style.height = 'auto';
  box.style.height = `${Math.min(box.scrollHeight, 140)}px`;
}

/* ---------- Asking ---------- */

async function ask(question: string): Promise<void> {
  if (streaming) return;
  addMessage('user').body.textContent = question; // textContent: never parse user text as HTML
  const reply = addMessage('coach');
  reply.body.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
  setStreaming(true);
  controller = new AbortController();
  let text = '';

  try {
    await streamCoach(
      question,
      (chunk) => {
        const stick = nearBottom(); // measure BEFORE appending, so growth doesn't fool the check
        text += chunk;
        reply.body.textContent = text;
        if (stick) scrollDown();
        else $('jump').hidden = false;
      },
      controller.signal,
    );
    if (text) {
      const done = text;
      addTool(reply, 'Copy', () => void copyText(done));
    } else {
      reply.body.textContent = 'The coach sent an empty reply. Try rephrasing your question.';
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      reply.body.textContent = text ? `${text}\n\n(stopped)` : '(stopped)';
    } else {
      reply.bubble.classList.add('error');
      reply.body.textContent = `${text ? `${text}\n\n` : ''}⚠ ${messageOf(error)}`;
      addTool(reply, 'Try again', () => {
        reply.row.previousElementSibling?.remove(); // the user bubble this reply belonged to
        reply.row.remove();
        void ask(question);
      });
    }
  } finally {
    controller = null;
    setStreaming(false);
    $('q').focus();
  }
}

function clearChat(): void {
  controller?.abort();
  $('chat').innerHTML = EMPTY_HTML;
  $('jump').hidden = true;
}

/* ---------- Setup ---------- */

export function focusCoach(): void {
  $('q').focus();
}

export function initCoach(): void {
  $('coach').innerHTML = TEMPLATE;
  const box = $<HTMLTextAreaElement>('q');

  box.addEventListener('input', () => {
    autosize();
    updateSend();
  });
  box.addEventListener('keydown', (ev) => {
    // isComposing: don't send while an IME (e.g. Hindi/Chinese keyboard) is still choosing characters
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      $<HTMLFormElement>('chat-form').requestSubmit();
    }
  });

  $<HTMLFormElement>('chat-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (streaming) {
      controller?.abort();
      return;
    }
    const question = box.value.trim();
    if (!question) return;
    box.value = '';
    autosize();
    updateSend();
    void ask(question);
  });

  $('chat').addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const chip = target.closest<HTMLElement>('[data-q]');
    if (chip?.dataset.q) void ask(chip.dataset.q);
  });
  $('chat').addEventListener('scroll', () => {
    if (nearBottom()) $('jump').hidden = true;
  });
  $('jump').addEventListener('click', scrollDown);
  $('clear-chat').addEventListener('click', clearChat);
}

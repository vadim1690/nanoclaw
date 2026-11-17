/**
 * Right-to-left layout for Hebrew on Telegram (local customization, 8.11.26).
 *
 * Lives in its own file so the add-telegram skill refresh, which rewrites
 * src/channels/telegram.ts on every update, cannot drop it. installRtlLayout()
 * patches the adapter class once at host start; applyRtlLayout() patches one
 * adapter instance (used by telegram-rtl.test.ts).
 */
import { TelegramAdapter, createTelegramAdapter } from '@chat-adapter/telegram';

import { log } from '../log.js';

// Hebrew, Arabic and nearby RTL scripts, plus their presentation forms.
const RTL_LETTERS = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g;
const LATIN_LETTERS = /[A-Za-z\u00C0-\u024F]/g;
/** Share of RTL letters (among RTL + Latin) at which a message is laid out right-to-left. */
const RTL_SHARE = 0.3;
const RLM = '\u200F';
const TELEGRAM_TEXT_LIMIT = 4096;
const TEXT_METHODS = new Set(['sendMessage', 'editMessageText', 'sendMessageDraft']);

/**
 * True when a message is mostly RTL prose. Code, link targets, HTML tags and
 * bare URLs don't count, so a Hebrew reply full of English identifiers still
 * qualifies and an English reply that quotes one Hebrew word doesn't.
 */
export function isRtlText(text: string): boolean {
  const prose = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
  const rtl = prose.match(RTL_LETTERS)?.length ?? 0;
  if (rtl === 0) return false;
  const latin = prose.match(LATIN_LETTERS)?.length ?? 0;
  return rtl / (rtl + latin) >= RTL_SHARE;
}

/**
 * Prefix every line with an RLM so each paragraph starts right-to-left. Code
 * fences and code lines are left alone, and a quote keeps its `>` first.
 */
export function addLineRlm(text: string): string {
  let inCode = false;
  return text
    .split('\n')
    .map((line) => {
      if (line.startsWith('```')) {
        inCode = !inCode;
        return line;
      }
      if (inCode || line === '' || line.startsWith(RLM)) return line;
      if (line.startsWith('>')) return `>${RLM}${line.slice(1)}`;
      return RLM + line;
    })
    .join('\n');
}

/**
 * Lay out RTL messages right-to-left. Rich messages get Bot API `is_rtl`
 * (bullets, indents, headings and tables mirror natively). Plain/MarkdownV2
 * messages (cards, attachments, rich fallback) get a leading RLM per line,
 * unless that would push them past Telegram's length limit.
 */
export function withRtlLayout(method: string, payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || payload instanceof FormData) return payload;
  const p = payload as Record<string, unknown>;
  const rich = p.rich_message;
  if (rich && typeof rich === 'object') {
    const r = rich as Record<string, unknown>;
    const content = typeof r.markdown === 'string' ? r.markdown : typeof r.html === 'string' ? r.html : '';
    if (r.is_rtl !== undefined || !isRtlText(content)) return payload;
    return { ...p, rich_message: { ...r, is_rtl: true } };
  }
  if (TEXT_METHODS.has(method) && typeof p.text === 'string' && isRtlText(p.text)) {
    const text = addLineRlm(p.text);
    return text.length <= TELEGRAM_TEXT_LIMIT ? { ...p, text } : payload;
  }
  return payload;
}

/**
 * Route every Bot API call through withRtlLayout. The adapter has no option
 * for `is_rtl`; its internal `telegramFetch` is the single choke point for
 * posts, edits and drafts. telegram-rtl.test.ts goes red if that moves.
 */
export function applyRtlLayout(adapter: ReturnType<typeof createTelegramAdapter>): void {
  const a = adapter as unknown as {
    telegramFetch?: (method: string, payload?: unknown, ...rest: unknown[]) => unknown;
  };
  const original = a.telegramFetch;
  if (typeof original !== 'function') {
    log.warn('Telegram adapter has no telegramFetch; RTL layout is not applied');
    return;
  }
  a.telegramFetch = (method, payload, ...rest) =>
    original.call(adapter, method, withRtlLayout(method, payload), ...rest);
}

/** Patch every Telegram adapter (class prototype) once; safe to call repeatedly. */
export function installRtlLayout(): void {
  const proto = TelegramAdapter.prototype as unknown as {
    telegramFetch?: (method: string, payload?: unknown, ...rest: unknown[]) => unknown;
    __nanoclawRtl?: boolean;
  };
  if (proto.__nanoclawRtl) return;
  const original = proto.telegramFetch;
  if (typeof original !== 'function') {
    log.warn('Telegram adapter has no telegramFetch; RTL layout is not applied');
    return;
  }
  proto.telegramFetch = function (this: unknown, method: string, payload?: unknown, ...rest: unknown[]) {
    return original.call(this, method, withRtlLayout(method, payload as never), ...rest);
  };
  proto.__nanoclawRtl = true;
}

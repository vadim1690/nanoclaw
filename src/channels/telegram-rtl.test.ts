/**
 * RTL layout for Telegram. applyRtlLayout wraps an internal adapter method
 * (telegramFetch), so the integration cases run the real adapter against a
 * stubbed Bot API: if the method moves or stops carrying posts, they go red.
 */
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { addLineRlm, applyRtlLayout, isRtlText, withRtlLayout } from './telegram.js';

const RLM = '\u200F';
const CHAT_ID = 12345;

type Body = { rich_message: { is_rtl?: boolean; markdown: string }; text: string; parse_mode?: string };
type Call = { method: string; body: Body };

function stubBotApi(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: unknown }) => {
      calls.push({
        method: String(url).split('/').pop() ?? '',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
      });
      return new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: 1, date: 0, chat: { id: CHAT_ID, type: 'private' }, text: 'x' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  return calls;
}

function rtlAdapter() {
  const adapter = createTelegramAdapter({ botToken: '1:test', mode: 'polling' });
  applyRtlLayout(adapter);
  return adapter;
}

describe('isRtlText', () => {
  it('is true for Hebrew prose', () => {
    expect(isRtlText('**בוקר טוב!** יש לך 3 דברים ביומן.')).toBe(true);
  });

  it('is true for Hebrew prose full of English identifiers in code and links', () => {
    expect(
      isRtlText('עדכנתי את `NanoClaw`, `OneCLI` ו-`Traefik` [כאן](https://github.com/vadim1690/nanoclaw/pull/1)'),
    ).toBe(true);
  });

  it('is false for English, even with one Hebrew word', () => {
    expect(isRtlText('Build passed on main, all 37 checks green. Ask דיאנה later.')).toBe(false);
  });

  it('is false with no letters at all', () => {
    expect(isRtlText('...')).toBe(false);
    expect(isRtlText('```\nשלום\n```')).toBe(false);
  });
});

describe('addLineRlm', () => {
  it('prefixes prose lines, skips code fences, keeps quotes intact', () => {
    const out = addLineRlm('*כותרת*\n\n\\- פריט\n```\nconst x = 1\n```\n>ציטוט');
    expect(out).toBe(`${RLM}*כותרת*\n\n${RLM}\\- פריט\n\`\`\`\nconst x = 1\n\`\`\`\n>${RLM}ציטוט`);
  });

  it('is idempotent', () => {
    const once = addLineRlm('שורה\nעוד שורה');
    expect(addLineRlm(once)).toBe(once);
  });
});

describe('withRtlLayout', () => {
  it('leaves an explicit is_rtl alone', () => {
    const payload = { rich_message: { markdown: 'שלום עולם', is_rtl: false } };
    expect(withRtlLayout('sendRichMessage', payload)).toBe(payload);
  });

  it('leaves FormData uploads alone', () => {
    const form = new FormData();
    expect(withRtlLayout('sendDocument', form)).toBe(form);
  });

  it('skips the RLM when it would push a message past 4096 characters', () => {
    const long = {
      text: Array.from({ length: 1400 }, () => 'שלום')
        .join('\n')
        .slice(0, 4090),
    };
    expect(withRtlLayout('sendMessage', long)).toBe(long);
  });
});

describe('applyRtlLayout (real adapter)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a Hebrew markdown post as a rich message with is_rtl', async () => {
    const calls = stubBotApi();
    await rtlAdapter().postMessage(`telegram:${CHAT_ID}`, { markdown: '### היום\n\n- **09:00** פגישה\n  - תת-פריט' });

    const call = calls.find((c) => c.method === 'sendRichMessage');
    expect(call?.body.rich_message.is_rtl).toBe(true);
    expect(call?.body.rich_message.markdown).toContain('- **09:00** פגישה');
  });

  it('keeps an English post left-to-right', async () => {
    const calls = stubBotApi();
    await rtlAdapter().postMessage(`telegram:${CHAT_ID}`, { markdown: '**Deploy done.** All checks green.' });

    const call = calls.find((c) => c.method === 'sendRichMessage');
    expect(call?.body.rich_message.is_rtl).toBeUndefined();
  });

  it('sets is_rtl on rich edits', async () => {
    const calls = stubBotApi();
    await rtlAdapter().editMessage(`telegram:${CHAT_ID}`, `${CHAT_ID}:1`, { markdown: 'עודכן: **הכל ירוק**' });

    const call = calls.find((c) => c.method === 'editMessageText');
    expect(call?.body.rich_message.is_rtl).toBe(true);
  });

  it('adds RLM marks to a Hebrew post that falls back to sendMessage', async () => {
    const calls = stubBotApi();
    const adapter = rtlAdapter();
    (adapter as unknown as { richMessagesAvailable: boolean }).richMessagesAvailable = false;
    await adapter.postMessage(`telegram:${CHAT_ID}`, { markdown: '**שלום** עולם\n\n- פריט' });

    const call = calls.find((c) => c.method === 'sendMessage');
    expect(call?.body.parse_mode).toBe('MarkdownV2');
    expect(
      call?.body.text
        .split('\n')
        .filter(Boolean)
        .every((l) => l.startsWith(RLM)),
    ).toBe(true);
  });

  it('control: without applyRtlLayout a Hebrew post has no is_rtl', async () => {
    const calls = stubBotApi();
    const adapter = createTelegramAdapter({ botToken: '1:test', mode: 'polling' });
    await adapter.postMessage(`telegram:${CHAT_ID}`, { markdown: 'שלום עולם' });

    const call = calls.find((c) => c.method === 'sendRichMessage');
    expect(call?.body.rich_message.is_rtl).toBeUndefined();
  });
});

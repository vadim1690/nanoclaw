/**
 * Guards disableRichMessages against adapter drift. It reaches into an internal
 * field of @chat-adapter/telegram, so this runs the real adapter against a
 * stubbed Bot API: if the field is renamed or stops gating rich sends, a
 * markdown post goes out as sendRichMessage again and this goes red.
 */
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { disableRichMessages } from './telegram.js';

const CHAT_ID = 12345;

function stubBotApi(): string[] {
  const methods: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      methods.push(String(url).split('/').pop() ?? '');
      return new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: 1, date: 0, chat: { id: CHAT_ID, type: 'private' }, text: 'x' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  return methods;
}

describe('disableRichMessages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes the richMessagesAvailable flag on the adapter', () => {
    const adapter = createTelegramAdapter({ botToken: '1:test', mode: 'polling' });
    expect(typeof (adapter as unknown as { richMessagesAvailable?: unknown }).richMessagesAvailable).toBe('boolean');
  });

  it('sends markdown posts via sendMessage with MarkdownV2, not sendRichMessage', async () => {
    const methods = stubBotApi();
    const adapter = createTelegramAdapter({ botToken: '1:test', mode: 'polling' });
    disableRichMessages(adapter);

    await adapter.postMessage(`telegram:${CHAT_ID}`, { markdown: '**שלום** עולם\n\n• פריט' });

    expect(methods).toContain('sendMessage');
    expect(methods.some((m) => m.startsWith('sendRichMessage'))).toBe(false);
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body));
    expect(body.parse_mode).toBe('MarkdownV2');
  });

  it('control: without the patch the adapter uses sendRichMessage', async () => {
    const methods = stubBotApi();
    const adapter = createTelegramAdapter({ botToken: '1:test', mode: 'polling' });

    await adapter.postMessage(`telegram:${CHAT_ID}`, { markdown: '**bold**' });

    expect(methods).toContain('sendRichMessage');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { getPendingMessages, markCompleted } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { forgetQuestion, getAskedQuestion, rememberQuestion, type AskedQuestion } from './db/questions.js';
import { formatMessages } from './formatter.js';
import { inboundForAgent, WAIT_GRACE_MS } from './late-answers.js';
import { askUserQuestion } from './mcp-tools/interactive.js';
import { runPollLoop } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';

beforeEach(() => {
  initTestSessionDb();
  const db = getInboundDb();
  db.prepare(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
     VALUES ('dm', 'DM', 'channel', 'telegram', 'telegram:1', NULL)`,
  ).run();
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_type TEXT, platform_id TEXT, thread_id TEXT
  )`);
  db.prepare(
    "INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, 'telegram', 'telegram:1', NULL)",
  ).run();
});
afterEach(() => closeSessionDb());

const COLORS: AskedQuestion = {
  title: 'בדיקת כפתורים: איזה צבע?',
  question: 'בדיקה בלבד',
  options: [
    { label: '⭐ כחול', value: '⭐ כחול' },
    { label: 'ירוק', value: 'ירוק' },
  ],
  waitingUntil: null,
};

let seq = 0;
/** The tap, as the host's src/modules/interactive writes it into messages_in. */
function tap(questionId: string, selectedOption: string, type = 'question_response'): void {
  seq += 2;
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, ?, 'system', ?, 'pending', 'telegram:1', 'telegram', NULL, ?)`,
    )
    .run(
      `qr-${questionId}`,
      seq,
      new Date().toISOString(),
      JSON.stringify({ type, questionId, selectedOption, userId: '1434' }),
    );
}

describe('inboundForAgent', () => {
  it('turns an answer no call waits for into a triggering message with the option and the question', () => {
    rememberQuestion('q1', COLORS);
    tap('q1', '⭐ כחול');

    const [message, ...rest] = inboundForAgent(getPendingMessages());
    expect(rest).toHaveLength(0);
    expect(message.kind).toBe('chat');
    expect(message.trigger).toBe(1);
    expect(message.id).toBe('qr-q1');
    const prompt = formatMessages([message]);
    expect(prompt).toContain('[כפתור] נבחר «⭐ כחול» בשאלה «בדיקת כפתורים: איזה צבע? — בדיקה בלבד»');
    expect(prompt).toContain('from="dm"');
    expect(getAskedQuestion('q1')).toBeUndefined();
  });

  it('leaves an answer to the blocking call that is waiting for it', () => {
    rememberQuestion('q1', { ...COLORS, waitingUntil: Date.now() + 60_000 });
    tap('q1', 'ירוק');

    expect(inboundForAgent(getPendingMessages())).toHaveLength(0);
    expect(getPendingMessages().map((m) => m.id)).toEqual(['qr-q1']);
    expect(getAskedQuestion('q1')?.waitingUntil).not.toBeNull();
  });

  it('never delivers an answer a blocking call read after the batch was fetched', () => {
    rememberQuestion('q1', { ...COLORS, waitingUntil: Date.now() + 60_000 });
    tap('q1', 'ירוק');
    const batch = getPendingMessages();
    // What the blocking call does on an answer: ack it, then forget the question.
    markCompleted(['qr-q1']);
    forgetQuestion('q1');

    expect(inboundForAgent(batch)).toHaveLength(0);
  });

  it('delivers the answer a crashed call was waiting for once its deadline and the grace are past', () => {
    rememberQuestion('q1', { ...COLORS, waitingUntil: Date.now() - WAIT_GRACE_MS - 1 });
    tap('q1', 'ירוק');

    const [message] = inboundForAgent(getPendingMessages());
    expect(JSON.parse(message.content).text).toContain('«ירוק»');
  });

  it('still delivers an answer to a question it has no record of, with the option alone', () => {
    tap('q-unknown', 'כן');

    const [message] = inboundForAgent(getPendingMessages());
    expect(JSON.parse(message.content).text).toBe('[כפתור] נבחר «כן»');
  });

  it('keeps every other system row hidden', () => {
    tap('q1', 'x', 'cli_response');
    getInboundDb()
      .prepare(
        "INSERT INTO messages_in (id, kind, timestamp, status, content) VALUES ('sys', 'system', ?, 'pending', 'not json')",
      )
      .run(new Date().toISOString());

    expect(inboundForAgent(getPendingMessages())).toHaveLength(0);
  });
});

// ── Through the poll loop ──

function startLoop(prompts: string[]): AbortController {
  const controller = new AbortController();
  const provider = new MockProvider({}, (prompt) => {
    prompts.push(prompt);
    return '<message to="dm">ok</message>';
  });
  void runPollLoop({
    provider,
    providerContract: { textDelivery: 'mid-turn-complete', commands: { formatting: 'xml' } },
    providerName: 'mock',
    cwd: '/tmp',
    signal: controller.signal,
  }).catch(() => {});
  return controller;
}

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('until: timeout');
    await Bun.sleep(25);
  }
}

describe('late answers through the poll loop', () => {
  it('wakes the agent with a late answer once, and never replays it', async () => {
    rememberQuestion('q1', COLORS);
    tap('q1', '⭐ כחול');
    const prompts: string[] = [];
    const loop = startLoop(prompts);
    await until(() => prompts.length === 1 && getPendingMessages().length === 0);
    await Bun.sleep(1500);
    loop.abort();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('[כפתור] נבחר «⭐ כחול»');
    // A fresh runner (a container restart) finds nothing to replay.
    const again: string[] = [];
    const second = startLoop(again);
    await Bun.sleep(1500);
    second.abort();
    expect(again).toHaveLength(0);
  });

  it('gives an answer to the blocking call that waits for it, and not to the agent as well', async () => {
    const prompts: string[] = [];
    const loop = startLoop(prompts);
    const asking = askUserQuestion.handler({ title: 'T', question: 'Q?', options: ['כן', 'לא'], timeout: 10 });
    await until(() => getUndeliveredMessages().length === 1);
    const { questionId } = JSON.parse(getUndeliveredMessages()[0].content);
    tap(questionId, 'כן');

    expect((await asking).content[0].text).toBe('כן');
    await Bun.sleep(1500);
    loop.abort();
    expect(prompts).toHaveLength(0);
    expect(getPendingMessages()).toHaveLength(0);
  });

  it('delivers a tap that comes after the blocking call timed out', async () => {
    const prompts: string[] = [];
    const loop = startLoop(prompts);
    const asking = askUserQuestion.handler({ title: 'T', question: 'Q?', options: ['כן', 'לא'], timeout: 1 });
    await until(() => getUndeliveredMessages().length === 1);
    const { questionId } = JSON.parse(getUndeliveredMessages()[0].content);
    const result = await asking;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('reaches you as a new message');

    tap(questionId, 'לא');
    await until(() => prompts.length === 1);
    loop.abort();
    expect(prompts[0]).toContain('[כפתור] נבחר «לא» בשאלה «T — Q?»');
  });
});

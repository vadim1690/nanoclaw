/**
 * Answers to ask_user_question that reach the agent as messages.
 *
 * A tap on a question card comes back as a `question_response` system row
 * (the host's src/modules/interactive). While a blocking ask_user_question
 * call is waiting for it, that call reads it and the poll loop leaves it
 * alone. Every other answer (to a `wait: false` question, or a tap after the
 * call timed out, hours later included) becomes a chat message that wakes the
 * agent. The row keeps its id, so it is acked completed like any message and
 * never delivered twice. Other system rows stay hidden: MCP tools read those
 * replies themselves (CLI responses, for one).
 */
import { findQuestionResponse, type MessageInRow } from './db/messages-in.js';
import { forgetQuestion, getAskedQuestion, type AskedQuestion } from './db/questions.js';

/**
 * How long past its deadline a blocking call keeps its claim on the answer.
 * It covers the call's last poll; after it, an answer that a crashed or killed
 * call left behind is delivered as a message.
 */
export const WAIT_GRACE_MS = 60_000;

/** The question as quoted in the message: enough to recognize it, never the whole card. */
const QUOTE_LIMIT = 300;

/** The rows the agent sees: system rows dropped, except answers no call is waiting for. */
export function inboundForAgent(messages: MessageInRow[], now = Date.now()): MessageInRow[] {
  return messages.flatMap((message) => {
    if (message.kind !== 'system') return [message];
    const answer = asAnswerMessage(message, now);
    return answer ? [answer] : [];
  });
}

function asAnswerMessage(message: MessageInRow, now: number): MessageInRow | null {
  let content: { type?: unknown; questionId?: unknown; selectedOption?: unknown; userId?: unknown };
  try {
    content = JSON.parse(message.content);
  } catch {
    return null;
  }
  if (content?.type !== 'question_response' || typeof content.questionId !== 'string') return null;
  const questionId = content.questionId;
  const asked = getAskedQuestion(questionId);
  if (asked?.waitingUntil && now < asked.waitingUntil + WAIT_GRACE_MS) return null;
  // A blocking call may have read the answer since this batch was fetched: it
  // acks the row before it forgets the question, so the row is gone here.
  if (findQuestionResponse(questionId)?.id !== message.id) return null;
  forgetQuestion(questionId);

  const selected = typeof content.selectedOption === 'string' ? content.selectedOption : '';
  const sender = typeof content.userId === 'string' && content.userId ? content.userId : undefined;
  return {
    ...message,
    kind: 'chat',
    trigger: 1,
    content: JSON.stringify({ text: answerText(selected, asked), sender, questionId, selectedOption: selected }),
  };
}

/** `[כפתור] נבחר «option» בשאלה «title — question»`; just the option when the question is unknown. */
export function answerText(selected: string, asked?: AskedQuestion): string {
  const option = asked?.options.find((o) => o.value === selected);
  const chosen = option && option.label !== selected ? `«${option.label}» (value: ${selected})` : `«${selected}»`;
  if (!asked) return `[כפתור] נבחר ${chosen}`;
  const about = asked.question && asked.question !== asked.title ? `${asked.title} — ${asked.question}` : asked.title;
  return `[כפתור] נבחר ${chosen} בשאלה «${truncate(about, QUOTE_LIMIT)}»`;
}

function truncate(text: string, limit: number): string {
  const chars = [...text];
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join('')}…`;
}

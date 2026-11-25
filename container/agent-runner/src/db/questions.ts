/**
 * The questions ask_user_question has posted, kept in mailbox state so an
 * answer that arrives after the call returned can still be shown with its
 * question, after a container restart too.
 *
 * The MCP server (which asks and may wait) and the poll loop (which delivers
 * every other answer as a message) are separate processes. This record is how
 * the poll loop knows that a blocking call is still waiting for an answer and
 * must be left to read it. One key per question, so the two processes never
 * rewrite each other's entries.
 */
import { getAgentMailbox } from '../mailbox/index.js';

export interface AskedQuestion {
  title: string;
  question: string;
  options: Array<{ label: string; value: string }>;
  /** Epoch ms until which a blocking call waits for the answer; null when no call waits. */
  waitingUntil: number | null;
}

function key(questionId: string): string {
  return `question:${questionId}`;
}

export function rememberQuestion(questionId: string, question: AskedQuestion): void {
  getAgentMailbox().operations.setState(key(questionId), JSON.stringify(question));
}

export function getAskedQuestion(questionId: string): AskedQuestion | undefined {
  const row = getAgentMailbox().operations.getState(key(questionId));
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as AskedQuestion;
  } catch {
    return undefined;
  }
}

/** The blocking call is done waiting: from now on the poll loop delivers the answer. */
export function stopWaiting(questionId: string): void {
  const question = getAskedQuestion(questionId);
  if (question && question.waitingUntil !== null) rememberQuestion(questionId, { ...question, waitingUntil: null });
}

export function forgetQuestion(questionId: string): void {
  getAgentMailbox().operations.deleteState(key(questionId));
}

/**
 * Auto-connect a new group to a new agent by name (fork addition, 19.11.2026).
 *
 * The owner sets up an agent's chat by creating a group named like the agent,
 * adding the bot and mentioning it. Picking "Choose existing agent → <name>" on
 * the "Bot mentioned in new channel" card is then just ceremony. This channel
 * card interceptor connects the group directly when all of these hold:
 *  - the group's title equals the display name or folder of exactly one agent
 *    group (trimmed, case-insensitive);
 *  - that agent has no wiring yet, i.e. it is new, so an existing agent can't be
 *    pulled into another chat this way;
 *  - the mention comes from an owner.
 * Anything else returns 'card', and the normal card flow runs.
 *
 * The wiring matches an approved card: channel defaults, sender_scope 'known',
 * the owner admitted as a member, and the mention replayed so the agent answers.
 */
import type { InboundEvent } from '../../channels/adapter.js';
import { resolveWiringDefaults } from '../../channels/channel-defaults.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { createMessagingGroupAgent, updateMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { routeInbound } from '../../router.js';
import type { MessagingGroup } from '../../types.js';
import { registerChannelCardInterceptor, type ChannelCardDecision } from './channel-approval.js';
import { addMember } from './db/agent-group-members.js';
import { isOwner } from './db/user-roles.js';

/** The sender's namespaced user id, read the same way as the permissions module (no side effects). */
export function senderUserId(event: InboundEvent): string | null {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(event.message.content) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof SyntaxError) return null;
    throw e;
  }
  const author =
    typeof content.author === 'object' && content.author !== null
      ? (content.author as Record<string, unknown>)
      : undefined;
  const raw =
    (typeof content.senderId === 'string' ? content.senderId : undefined) ??
    (typeof content.sender === 'string' ? content.sender : undefined) ??
    (typeof author?.userId === 'string' ? (author.userId as string) : undefined);
  if (!raw) return null;
  return raw.includes(':') ? raw : `${event.channelType}:${raw}`;
}

const norm = (s: string): string => s.normalize('NFKC').trim().toLowerCase();

async function groupTitle(mg: MessagingGroup): Promise<string | null> {
  if (mg.name) return mg.name;
  const adapter = getChannelAdapter(mg.instance ?? mg.channel_type);
  let name: string | null = null;
  try {
    name = (await adapter?.resolveConversation?.(mg.platform_id))?.name ?? null;
    if (!name) name = (await adapter?.resolveChannelName?.(mg.platform_id)) ?? null;
  } catch (err) {
    log.warn('Auto-connect: could not resolve the group title; falling back to the card', {
      messagingGroupId: mg.id,
      err,
    });
    return null;
  }
  if (name) await updateMessagingGroup(mg.id, { name });
  return name;
}

export async function autoConnectByName(mg: MessagingGroup, event: InboundEvent): Promise<ChannelCardDecision> {
  const isGroup = event.message.isGroup ?? mg.is_group === 1;
  if (!isGroup) return 'card';
  const sender = senderUserId(event);
  if (!sender || !(await isOwner(sender))) return 'card';

  const title = await groupTitle(mg);
  if (!title) return 'card';
  const matches = (await getAllAgentGroups()).filter(
    (g) => norm(g.name) === norm(title) || norm(g.folder) === norm(title),
  );
  if (matches.length !== 1) return 'card';
  const agent = matches[0];
  const wired = await getDb().get<{ x: number }>(
    'SELECT 1 AS x FROM messaging_group_agents WHERE agent_group_id = ? LIMIT 1',
    agent.id,
  );
  if (wired) return 'card';

  const engage = resolveWiringDefaults(mg.instance ?? mg.channel_type, true, agent.name, mg.channel_type);
  const mgaId = `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  await getDb().transaction(async () => {
    await createMessagingGroupAgent({
      id: mgaId,
      messaging_group_id: mg.id,
      agent_group_id: agent.id,
      engage_mode: engage.engage_mode,
      engage_pattern: engage.engage_pattern,
      sender_scope: 'known',
      ignored_message_policy: 'accumulate',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    await addMember({ user_id: sender, agent_group_id: agent.id, added_by: sender, added_at: now });
  });
  log.info('Auto-connected a new group to a new agent by name', {
    messagingGroupId: mg.id,
    agentGroupId: agent.id,
    title,
    mgaId,
    owner: sender,
  });

  try {
    await routeInbound(event);
  } catch (err) {
    log.error('Auto-connect: failed to replay the mention', { messagingGroupId: mg.id, err });
  }
  return 'handled';
}

registerChannelCardInterceptor('telegram', autoConnectByName);

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const approvals = vi.hoisted(() => ({ requestApproval: vi.fn(async () => undefined) }));

vi.mock('../../modules/approvals/index.js', async () => ({
  ...(await vi.importActual<typeof import('../../modules/approvals/index.js')>('../../modules/approvals/index.js')),
  requestApproval: approvals.requestApproval,
}));

vi.mock('../../db/sessions.js', async () => ({
  ...(await vi.importActual<typeof import('../../db/sessions.js')>('../../db/sessions.js')),
  getSession: vi.fn(async (id: string) => ({ id, agent_group_id: 'ag-admin', messaging_group_id: 'mg-1' })),
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import './grants.js';

const host: CallerContext = { caller: 'host' };
const admin: CallerContext = { caller: 'agent', agentGroupId: 'ag-admin', sessionId: 's-1', messagingGroupId: 'mg-1' };
const scoped: CallerContext = {
  caller: 'agent',
  agentGroupId: 'ag-scoped',
  sessionId: 's-2',
  messagingGroupId: 'mg-2',
};

/** In-memory OneCLI: just the routes `ncl grants` calls. */
function fakeOneCli() {
  const agents = [{ id: 'oc-admin', identifier: 'ag-admin', name: 'Admin', accessToken: 'aoc_never_shown' }];
  const connections = [
    { id: 'c-gmail-me', provider: 'gmail', label: 'me@example.com', status: 'connected' },
    { id: 'c-gmail-home', provider: 'gmail', label: 'home@example.com', status: 'connected' },
    { id: 'c-drive-me', provider: 'google-drive', label: 'me@example.com', status: 'connected' },
    { id: 'c-old', provider: 'youtube', label: 'me@example.com', status: 'revoked' },
  ];
  const secrets = [{ id: 's-groq', name: 'Groq API Key', hostPattern: 'api.groq.com', value: 'gsk_never_shown' }];
  const tools: Record<string, unknown> = {
    gmail: {
      provider: 'gmail',
      groups: [
        {
          category: 'read',
          tools: [
            { id: 'search_messages', name: 'Search' },
            { id: 'get_message', name: 'Read' },
          ],
        },
        {
          category: 'write',
          tools: [
            { id: 'create_draft', name: 'Draft' },
            { id: 'send_email', name: 'Send' },
          ],
          wildcard: { id: 'write_all', name: 'All writes' },
        },
      ],
    },
  };
  const grants = new Map<
    string,
    { connections: Array<Record<string, unknown>>; secrets: Array<Record<string, unknown>> }
  >();
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];

  const json = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = url.pathname;
    calls.push({ method, path, body });
    const g = (id: string) => grants.get(id) ?? grants.set(id, { connections: [], secrets: [] }).get(id)!;

    if (path === '/v1/agents' && method === 'GET') return json(200, { data: agents });
    if (path === '/v1/agents' && method === 'POST') {
      const a = { id: `oc-${agents.length}`, identifier: body.identifier, name: body.name, accessToken: 'aoc_x' };
      agents.push(a);
      return json(201, a);
    }
    if (path === '/v1/apps/connections') return json(200, { connections });
    if (path === '/v1/secrets') return json(200, secrets);
    let m = path.match(/^\/v1\/apps\/([^/]+)\/permission-definition$/);
    if (m) return tools[m[1]] ? json(200, tools[m[1]]) : json(404, { error: 'unknown app' });
    m = path.match(/^\/v1\/agents\/([^/]+)\/grants$/);
    if (m) return json(200, { agentId: m[1], mode: 'grants', ...g(m[1]) });
    m = path.match(/^\/v1\/agents\/([^/]+)\/grants\/connections\/([^/]+)$/);
    if (m) {
      const list = g(m[1]).connections.filter((c) => c.connectionId !== m![2]);
      if (method === 'PUT') {
        const c = connections.find((x) => x.id === m![2])!;
        list.push({
          connectionId: c.id,
          provider: c.provider,
          label: c.label,
          access: body.access,
          allow: body.allow ?? [],
          ask: body.ask ?? [],
        });
      }
      g(m[1]).connections = list;
      return method === 'PUT' ? json(200, { ok: true }) : json(204);
    }
    m = path.match(/^\/v1\/agents\/([^/]+)\/grants\/secrets\/([^/]+)$/);
    if (m) {
      const list = g(m[1]).secrets.filter((s) => s.secretId !== m![2]);
      if (method === 'PUT') list.push({ secretId: m[2], name: secrets.find((s) => s.id === m![2])!.name });
      g(m[1]).secrets = list;
      return method === 'PUT' ? json(200, { ok: true }) : json(204);
    }
    return json(404, { error: `no route ${method} ${path}` });
  };
  return { handler, calls, grants, agents };
}

let one: ReturnType<typeof fakeOneCli>;

async function run(command: string, args: Record<string, unknown>, ctx: CallerContext = host) {
  return dispatch({ id: command, command, args }, ctx);
}

beforeEach(async () => {
  process.env.ONECLI_URL = 'http://onecli.test';
  one = fakeOneCli();
  vi.spyOn(globalThis, 'fetch').mockImplementation(one.handler as typeof fetch);
  approvals.requestApproval.mockClear();
  const db = await initTestDb();
  await runMigrations(db);
  for (const [id, folder] of [
    ['ag-admin', 'admin'],
    ['ag-scoped', 'scoped'],
    ['ag-new', 'new-agent'],
  ]) {
    await createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() });
    await ensureContainerConfig(id);
  }
  await updateContainerConfigScalars('ag-admin', { cli_scope: 'global' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.ONECLI_URL;
  await closeDb();
});

describe('ncl grants: reading', () => {
  it('available lists connected accounts and secret names, never values or tokens', async () => {
    const resp = await run('grants-available', {});
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data).toEqual({
      connections: [
        { app: 'gmail', account: 'me@example.com' },
        { app: 'gmail', account: 'home@example.com' },
        { app: 'google-drive', account: 'me@example.com' },
      ],
      secrets: [{ name: 'Groq API Key', host: 'api.groq.com' }],
    });
    expect(JSON.stringify(resp)).not.toMatch(/never_shown/);
  });

  it('available --app lists the tool ids for --allow/--ask', async () => {
    const resp = await run('grants-available', { app: 'gmail' });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.human).toContain('read: search_messages, get_message');
    expect(resp.human).toContain('write: create_draft, send_email (all: write_all)');
  });

  it('list shows an agent with no identity yet', async () => {
    const resp = await run('grants-list', { group: 'new-agent' });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data).toMatchObject({ group: 'new-agent', identity: 'not created yet', connections: [], secrets: [] });
  });

  it('check validates without changing anything', async () => {
    const resp = await run('grants-check', {
      group: 'new-agent',
      app: 'gmail',
      account: 'ME@example.com',
      allow: 'search_messages,get_message',
      ask: 'send_email',
    });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.human).toContain('Nothing changed');
    expect(one.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('ncl grants: changes from the host', () => {
  it('attach creates the identity of a never-run agent and stores a custom rule', async () => {
    const resp = await run('grants-attach', {
      group: 'new-agent',
      app: 'gmail',
      account: 'me@example.com',
      allow: 'search_messages,get_message',
      ask: 'send_email',
    });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    const created = one.calls.find((c) => c.method === 'POST' && c.path === '/v1/agents');
    expect(created?.body).toEqual({ name: 'new-agent', identifier: 'ag-new' });
    const put = one.calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe('/v1/agents/oc-1/grants/connections/c-gmail-me');
    expect(put?.body).toEqual({ access: 'custom', allow: ['search_messages', 'get_message'], ask: ['send_email'] });
    expect(resp.data).toMatchObject({
      identity: 'present',
      connections: [{ app: 'gmail', account: 'me@example.com', access: 'custom', ask: ['send_email'] }],
    });
  });

  it('attach --access full sends a full rule', async () => {
    const resp = await run('grants-attach', {
      group: 'admin',
      app: 'google-drive',
      account: 'me@example.com',
      access: 'full',
    });
    expect(resp.ok).toBe(true);
    expect(one.calls.find((c) => c.method === 'PUT')?.body).toEqual({ access: 'full' });
  });

  it('refuses an attach that does not say what the agent may do', async () => {
    const resp = await run('grants-attach', { group: 'admin', app: 'gmail', account: 'me@example.com' });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/say what the agent may do/);
    expect(one.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('refuses unknown tool ids and lists the valid ones', async () => {
    const resp = await run('grants-attach', {
      group: 'admin',
      app: 'gmail',
      account: 'me@example.com',
      allow: 'delete_everything',
    });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/unknown gmail tool ids: delete_everything.*send_email/);
  });

  it('refuses a tool that is both allowed and asked, and full mixed with a list', async () => {
    const both = await run('grants-attach', {
      group: 'admin',
      app: 'gmail',
      account: 'me@example.com',
      allow: 'send_email',
      ask: 'send_email',
    });
    expect(both.ok).toBe(false);
    const mixed = await run('grants-attach', {
      group: 'admin',
      app: 'gmail',
      account: 'me@example.com',
      access: 'full',
      allow: 'get_message',
    });
    expect(mixed.ok).toBe(false);
  });

  it('names the connected accounts when the account is wrong, and skips revoked connections', async () => {
    const wrong = await run('grants-attach', {
      group: 'admin',
      app: 'gmail',
      account: 'other@example.com',
      access: 'full',
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.message).toContain('me@example.com, home@example.com');
    const revoked = await run('grants-attach', {
      group: 'admin',
      app: 'youtube',
      account: 'me@example.com',
      access: 'full',
    });
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.error.message).toMatch(/no youtube connection.*OAuth connect step/);
  });

  it('refuses an unknown agent group', async () => {
    const resp = await run('grants-attach', {
      group: 'nobody',
      app: 'gmail',
      account: 'me@example.com',
      access: 'full',
    });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/no agent group "nobody"/);
  });

  it('detach removes a held connection and refuses one that is not held', async () => {
    await run('grants-attach', { group: 'admin', app: 'gmail', account: 'home@example.com', access: 'full' });
    const off = await run('grants-detach', { group: 'admin', app: 'gmail', account: 'home@example.com' });
    expect(off.ok).toBe(true);
    if (off.ok) expect(off.data).toMatchObject({ connections: [] });
    const again = await run('grants-detach', { group: 'admin', app: 'gmail', account: 'home@example.com' });
    expect(again.ok).toBe(false);
  });

  it('attach-secret and detach-secret work by secret name', async () => {
    const on = await run('grants-attach-secret', { group: 'admin', secret: 'groq api key' });
    expect(on.ok).toBe(true);
    if (on.ok) expect(on.data).toMatchObject({ secrets: ['Groq API Key'] });
    const off = await run('grants-detach-secret', { group: 'admin', secret: 'Groq API Key' });
    expect(off.ok).toBe(true);
    if (off.ok) expect(off.data).toMatchObject({ secrets: [] });
  });
});

describe('ncl grants: agent callers', () => {
  it('an admin agent can read without a card', async () => {
    const resp = await run('grants-list', { group: 'admin' }, admin);
    expect(resp.ok).toBe(true);
    expect(approvals.requestApproval).not.toHaveBeenCalled();
  });

  it("an admin agent's attach is held on a card showing every argument, and nothing changes", async () => {
    const resp = await run(
      'grants-attach',
      { group: 'new-agent', app: 'gmail', account: 'me@example.com', allow: 'search_messages', ask: 'send_email' },
      admin,
    );
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('approval-pending');
    expect(approvals.requestApproval).toHaveBeenCalledTimes(1);
    const card = (approvals.requestApproval.mock.calls[0] as unknown[])[0] as { question: string; action: string };
    expect(card.action).toBe('cli_command');
    expect(card.question).toContain('ncl grants-attach');
    expect(card.question).toContain('--account "me@example.com"');
    expect(card.question).toContain('--ask "send_email"');
    expect(one.calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('every changing verb is approval-gated for an admin agent', async () => {
    for (const [command, args] of [
      ['grants-detach', { group: 'admin', app: 'gmail', account: 'me@example.com' }],
      ['grants-attach-secret', { group: 'admin', secret: 'Groq API Key' }],
      ['grants-detach-secret', { group: 'admin', secret: 'Groq API Key' }],
    ] as const) {
      const resp = await run(command, args, admin);
      expect(resp.ok).toBe(false);
      if (!resp.ok) expect(resp.error.code).toBe('approval-pending');
    }
    expect(one.calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('a group-scoped agent cannot use grants at all, not even to read', async () => {
    for (const command of ['grants-list', 'grants-available', 'grants-attach']) {
      const resp = await run(
        command,
        { group: 'scoped', app: 'gmail', account: 'me@example.com', access: 'full' },
        scoped,
      );
      expect(resp.ok).toBe(false);
      if (!resp.ok) expect(resp.error.code).toBe('forbidden');
    }
    expect(approvals.requestApproval).not.toHaveBeenCalled();
    expect(one.calls).toEqual([]);
  });
});

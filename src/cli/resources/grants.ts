/**
 * `ncl grants` — what an agent holds in the OneCLI gateway, and approval-gated
 * changes to it (fork addition, 19.11.2026).
 *
 * An admin agent (cli_scope=global) can create agents and wire chats, but had
 * no way to give a new agent Gmail, Drive or a tool key: grants were host-only.
 * These verbs close that gap without giving the container any gateway power:
 *  - `list`, `available` and `check` are read-only. They show providers,
 *    account labels, secret names and tool ids, never a secret value.
 *  - `attach`, `detach`, `attach-secret` and `detach-secret` are access
 *    'approval'. An agent's call is held and the admin sees the full command on
 *    a card before the host runs it. The arguments are human readable (agent
 *    folder, app, account e-mail, tool ids), so the card says exactly what
 *    will be granted.
 *  - `grants` is not in GROUP_SCOPE_RESOURCES, so group-scoped agents are
 *    refused outright.
 * Only connections that already exist in the gateway can be attached; a new
 * account still needs the OAuth connect step on the host.
 */
import { getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import {
  grantsClient,
  type AgentGrants,
  type GatewayConnection,
  type GrantRule,
  type GrantsClient,
} from '../../onecli-grants.js';
import type { AgentGroup } from '../../types.js';
import { registerResource, type ColumnDef } from '../crud.js';

async function resolveGroup(ref: unknown): Promise<AgentGroup> {
  const v = String(ref ?? '').trim();
  if (!v) throw new Error('--group is required: the agent folder or id from `ncl groups list`');
  const group = (await getAgentGroupByFolder(v)) ?? (await getAgentGroup(v));
  if (!group) throw new Error(`no agent group "${v}"; use the folder or id from \`ncl groups list\``);
  return group;
}

function csv(v: unknown): string[] {
  return [
    ...new Set(
      String(v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

async function resolveConnection(
  client: GrantsClient,
  appArg: unknown,
  accountArg: unknown,
): Promise<GatewayConnection> {
  const app = String(appArg ?? '')
    .trim()
    .toLowerCase();
  const account = String(accountArg ?? '')
    .trim()
    .toLowerCase();
  if (!app)
    throw new Error('--app is required, e.g. gmail, google-drive, google-calendar (see `ncl grants available`)');
  if (!account) throw new Error('--account is required: the account label shown by `ncl grants available`');
  const connected = (await client.connections()).filter((c) => c.status === 'connected');
  const forApp = connected.filter((c) => c.provider === app);
  if (forApp.length === 0) {
    const apps = [...new Set(connected.map((c) => c.provider))].sort().join(', ');
    throw new Error(
      `no ${app} connection in the gateway (connected apps: ${apps || 'none'}). ` +
        'A new app or account needs the OAuth connect step on the host first.',
    );
  }
  const match = forApp.filter((c) => c.label.toLowerCase() === account);
  if (match.length === 1) return match[0];
  if (match.length > 1) throw new Error(`more than one ${app} connection is labelled "${account}"; fix it on the host`);
  throw new Error(
    `no ${app} connection for "${account}"; connected ${app} accounts: ${forApp.map((c) => c.label).join(', ')}`,
  );
}

async function ruleFrom(client: GrantsClient, app: string, args: Record<string, unknown>): Promise<GrantRule> {
  const access = args.access === undefined ? undefined : String(args.access);
  const allow = csv(args.allow);
  const ask = csv(args.ask);
  if (access === 'full') {
    if (allow.length || ask.length) throw new Error('--access full cannot be combined with --allow or --ask');
    return { access: 'full' };
  }
  if (access !== undefined && access !== 'custom') throw new Error('--access must be "full" or "custom"');
  if (!allow.length && !ask.length) {
    throw new Error(
      'say what the agent may do: --access full, or --allow <tool ids> and/or --ask <tool ids> ' +
        `(ids: \`ncl grants available --app ${app}\`). Tools not listed are blocked.`,
    );
  }
  const both = allow.filter((t) => ask.includes(t));
  if (both.length) throw new Error(`a tool cannot be both allowed and approval-gated: ${both.join(', ')}`);
  const tools = await client.appTools(app);
  const unknown = [...allow, ...ask].filter((t) => !tools.all.includes(t));
  if (unknown.length) {
    throw new Error(`unknown ${app} tool ids: ${unknown.join(', ')}. Valid: ${tools.all.join(', ')}`);
  }
  return { access: 'custom', allow, ask };
}

interface GrantsView {
  group: string;
  name: string;
  identity: 'present' | 'not created yet';
  connections: Array<{ app: string; account: string; access: string; allow: string[]; ask: string[] }>;
  secrets: string[];
}

function view(group: AgentGroup, grants: AgentGrants | null): GrantsView {
  return {
    group: group.folder,
    name: group.name,
    identity: grants ? 'present' : 'not created yet',
    connections: (grants?.connections ?? []).map((c) => ({
      app: c.provider,
      account: c.label,
      access: c.access,
      allow: c.allow,
      ask: c.ask,
    })),
    secrets: (grants?.secrets ?? []).map((s) => s.name),
  };
}

async function currentView(client: GrantsClient, group: AgentGroup): Promise<GrantsView> {
  const agent = await client.findAgent(group.id);
  return view(group, agent ? await client.grants(agent.id) : null);
}

function formatView(data: unknown): string {
  const v = data as GrantsView;
  const lines = [`${v.name} (${v.group}), gateway identity: ${v.identity}`];
  if (!v.connections.length && !v.secrets.length) lines.push('  no app connections or secrets attached');
  for (const c of v.connections) {
    const rule =
      c.access === 'full'
        ? 'full access'
        : `allow: ${c.allow.join(', ') || '-'}; ask (approval card): ${c.ask.join(', ') || '-'}; everything else blocked`;
    lines.push(`  ${c.app} · ${c.account} · ${rule}`);
  }
  for (const s of v.secrets) lines.push(`  secret · ${s}`);
  return lines.join('\n');
}

const GROUP: ColumnDef = {
  name: 'group',
  type: 'string',
  description: 'Agent folder or id (from `ncl groups list`).',
  required: true,
};
const APP: ColumnDef = {
  name: 'app',
  type: 'string',
  description: 'Gateway app, e.g. gmail, google-drive, google-calendar.',
  required: true,
};
const ACCOUNT: ColumnDef = {
  name: 'account',
  type: 'string',
  description: 'Account label of the connection, as `ncl grants available` shows it (usually the e-mail).',
  required: true,
};
const RULE_ARGS: ColumnDef[] = [
  {
    name: 'access',
    type: 'string',
    description: '"full" for every tool of the app; omit for a custom rule.',
    enum: ['full', 'custom'],
  },
  { name: 'allow', type: 'string', description: 'Comma-separated tool ids the agent may use freely.' },
  { name: 'ask', type: 'string', description: 'Comma-separated tool ids that need an approval card each time.' },
];
const SECRET: ColumnDef = {
  name: 'secret',
  type: 'string',
  description: 'Secret name, as `ncl grants available` shows it.',
  required: true,
};

async function resolveSecret(client: GrantsClient, nameArg: unknown) {
  const name = String(nameArg ?? '')
    .trim()
    .toLowerCase();
  const all = await client.secrets();
  const match = all.filter((s) => s.name.toLowerCase() === name);
  if (match.length === 1) return match[0];
  if (match.length > 1) throw new Error(`more than one secret is named "${nameArg}"; fix it on the host`);
  throw new Error(`no secret named "${nameArg}"; secrets: ${all.map((s) => s.name).join(', ')}`);
}

registerResource({
  name: 'grant',
  plural: 'grants',
  // There is no grants table; with no generic operations nothing reads it.
  table: 'grants',
  description:
    'Credential grants in the OneCLI gateway: which app connections (Gmail, Drive, ...) and secrets an agent may use. ' +
    'Reading is open; every change needs admin approval.',
  idColumn: 'group',
  columns: [],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: "Show an agent's grants: app connections with their rule, and secret names.",
      args: [GROUP],
      examples: ['ncl grants list --group my-agent'],
      handler: async (args) => currentView(grantsClient(), await resolveGroup(args.group)),
      formatHuman: formatView,
    },
    available: {
      access: 'open',
      description:
        "What can be granted: connected app accounts and secret names. With --app, that app's tool ids for --allow/--ask.",
      args: [{ name: 'app', type: 'string', description: "Show this app's tool ids." }],
      examples: ['ncl grants available', 'ncl grants available --app gmail'],
      handler: async (args) => {
        const client = grantsClient();
        if (args.app) {
          const app = String(args.app).trim().toLowerCase();
          const accounts = (await client.connections()).filter((c) => c.provider === app && c.status === 'connected');
          return { app, accounts: accounts.map((c) => c.label), tools: (await client.appTools(app)).categories };
        }
        const connections = (await client.connections()).filter((c) => c.status === 'connected');
        return {
          connections: connections.map((c) => ({ app: c.provider, account: c.label })),
          secrets: (await client.secrets()).map((s) => ({ name: s.name, host: s.hostPattern })),
        };
      },
      formatHuman: (data) => {
        const d = data as {
          app?: string;
          accounts?: string[];
          tools?: Array<{ category: string; tools: Array<{ id: string; name: string }>; wildcard?: string }>;
          connections?: Array<{ app: string; account: string }>;
          secrets?: Array<{ name: string; host: string | null }>;
        };
        if (d.app) {
          const lines = [`${d.app} accounts: ${d.accounts?.join(', ') || 'none connected'}`];
          for (const c of d.tools ?? []) {
            lines.push(
              `${c.category}: ${c.tools.map((t) => t.id).join(', ')}${c.wildcard ? ` (all: ${c.wildcard})` : ''}`,
            );
          }
          return lines.join('\n');
        }
        return [
          'Connections (app · account):',
          ...(d.connections ?? []).map((c) => `  ${c.app} · ${c.account}`),
          'Secrets:',
          ...(d.secrets ?? []).map((s) => `  ${s.name}${s.host ? ` (${s.host})` : ''}`),
        ].join('\n');
      },
    },
    check: {
      access: 'open',
      description:
        'Validate an attach without changing anything (run it before `grants attach`, so the approval card is right first time).',
      args: [GROUP, APP, ACCOUNT, ...RULE_ARGS],
      examples: [
        'ncl grants check --group my-agent --app gmail --account me@example.com --allow search_messages,get_message --ask send_email',
      ],
      handler: async (args) => {
        const client = grantsClient();
        const group = await resolveGroup(args.group);
        const conn = await resolveConnection(client, args.app, args.account);
        const rule = await ruleFrom(client, conn.provider, args);
        return { ok: true, group: group.folder, app: conn.provider, account: conn.label, rule };
      },
      formatHuman: (data) => {
        const d = data as { group: string; app: string; account: string; rule: GrantRule };
        const rule =
          d.rule.access === 'full'
            ? 'full access'
            : `allow ${d.rule.allow?.join(', ') || '-'}; ask ${d.rule.ask?.join(', ') || '-'}`;
        return `OK: would give ${d.group} ${d.app} (${d.account}) with ${rule}. Nothing changed.`;
      },
    },
    attach: {
      access: 'approval',
      description:
        'Give an agent one app connection with a rule: --access full, or --allow / --ask tool ids (unlisted tools are blocked). ' +
        "Re-attaching replaces the rule. Creates the agent's gateway identity if it has never run.",
      args: [GROUP, APP, ACCOUNT, ...RULE_ARGS],
      examples: [
        'ncl grants attach --group my-agent --app gmail --account me@example.com --allow search_messages,get_message --ask send_email',
        'ncl grants attach --group my-agent --app google-calendar --account me@example.com --access full',
      ],
      handler: async (args) => {
        const client = grantsClient();
        const group = await resolveGroup(args.group);
        const conn = await resolveConnection(client, args.app, args.account);
        const rule = await ruleFrom(client, conn.provider, args);
        const agent = await client.ensureAgent(group.id, group.name);
        await client.attachConnection(agent.id, conn.id, rule);
        return view(group, await client.grants(agent.id));
      },
      formatHuman: formatView,
    },
    detach: {
      access: 'approval',
      description: 'Take one app connection away from an agent.',
      args: [GROUP, APP, ACCOUNT],
      examples: ['ncl grants detach --group my-agent --app gmail --account me@example.com'],
      handler: async (args) => {
        const client = grantsClient();
        const group = await resolveGroup(args.group);
        const conn = await resolveConnection(client, args.app, args.account);
        const agent = await client.findAgent(group.id);
        if (!agent) throw new Error(`${group.folder} has no gateway identity, so nothing is attached`);
        const held = (await client.grants(agent.id)).connections.some((c) => c.connectionId === conn.id);
        if (!held) throw new Error(`${group.folder} does not hold ${conn.provider} (${conn.label})`);
        await client.detachConnection(agent.id, conn.id);
        return view(group, await client.grants(agent.id));
      },
      formatHuman: formatView,
    },
    'attach-secret': {
      access: 'approval',
      description: 'Give an agent one vault secret by name (e.g. an API key the gateway injects on its host).',
      args: [GROUP, SECRET],
      examples: ['ncl grants attach-secret --group my-agent --secret "Groq API Key"'],
      handler: async (args) => {
        const client = grantsClient();
        const group = await resolveGroup(args.group);
        const secret = await resolveSecret(client, args.secret);
        const agent = await client.ensureAgent(group.id, group.name);
        await client.attachSecret(agent.id, secret.id);
        return view(group, await client.grants(agent.id));
      },
      formatHuman: formatView,
    },
    'detach-secret': {
      access: 'approval',
      description: 'Take one vault secret away from an agent.',
      args: [GROUP, SECRET],
      examples: ['ncl grants detach-secret --group my-agent --secret "Groq API Key"'],
      handler: async (args) => {
        const client = grantsClient();
        const group = await resolveGroup(args.group);
        const secret = await resolveSecret(client, args.secret);
        const agent = await client.findAgent(group.id);
        if (!agent) throw new Error(`${group.folder} has no gateway identity, so nothing is attached`);
        const held = (await client.grants(agent.id)).secrets.some((s) => s.secretId === secret.id);
        if (!held) throw new Error(`${group.folder} does not hold the secret "${secret.name}"`);
        await client.detachSecret(agent.id, secret.id);
        return view(group, await client.grants(agent.id));
      },
      formatHuman: formatView,
    },
  },
});

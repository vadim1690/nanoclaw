/**
 * OneCLI grants client for `ncl grants` (fork addition, 19.11.2026).
 *
 * Since OneCLI 1.44 an agent receives only what is attached to it. This
 * host-side client reads the gateway's app connections and vault secrets
 * (metadata only, never values) and attaches or detaches them for one agent
 * identity. It never runs inside a container: the changing verbs of
 * `ncl grants` are access 'approval', so an agent's request is held on an
 * admin card that shows the full command before this client is called.
 */
import { readEnvFile } from './env.js';

export interface GrantRule {
  access: 'full' | 'custom';
  allow?: string[];
  ask?: string[];
}

export interface GatewayConnection {
  id: string;
  provider: string;
  label: string;
  status: string;
}

export interface GatewaySecret {
  id: string;
  name: string;
  hostPattern: string | null;
}

export interface GatewayAgent {
  id: string;
  identifier: string;
  name: string;
}

export interface AgentGrants {
  agentId: string;
  connections: Array<{
    connectionId: string;
    provider: string;
    label: string;
    access: string;
    allow: string[];
    ask: string[];
  }>;
  secrets: Array<{ secretId: string; name: string }>;
}

export interface AppTools {
  provider: string;
  /** Tool ids per category ("read", "write", ...), in the gateway's order. */
  categories: Array<{ category: string; tools: Array<{ id: string; name: string }>; wildcard?: string }>;
  /** Every id the gateway accepts in allow/ask, wildcards included. */
  all: string[];
}

export interface GrantsClientOptions {
  baseUrl?: string;
  apiKey?: string;
  projectId?: string;
  fetchImpl?: typeof fetch;
}

type Row = Record<string, unknown>;

function rowsOf(body: unknown, key?: string): Row[] {
  if (Array.isArray(body)) return body as Row[];
  const obj = (body ?? {}) as Row;
  const inner = key ? obj[key] : undefined;
  if (Array.isArray(inner)) return inner as Row[];
  if (Array.isArray(obj.data)) return obj.data as Row[];
  throw new Error('OneCLI returned an unexpected list shape');
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function grantsClient(opts: GrantsClientOptions = {}) {
  const env = readEnvFile(['ONECLI_URL', 'ONECLI_API_KEY']);
  const base = (opts.baseUrl ?? process.env.ONECLI_URL ?? env.ONECLI_URL ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('ONECLI_URL is not configured; grants need the OneCLI gateway');
  const apiKey = opts.apiKey ?? process.env.ONECLI_API_KEY ?? env.ONECLI_API_KEY;
  const projectId = opts.projectId ?? process.env.ONECLI_PROJECT_ID;
  const doFetch = opts.fetchImpl ?? fetch;

  async function call(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (projectId) headers['X-Project-Id'] = projectId;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch (e) {
        // A non-JSON body (an HTML error page) is reported by status below.
        if (!(e instanceof SyntaxError)) throw e;
        json = null;
      }
    }
    if (!res.ok) {
      const e = (json ?? {}) as { error?: unknown; message?: unknown };
      const nested = (e.error ?? {}) as { message?: unknown };
      const msg = str(e.error) || str(nested.message) || str(e.message) || text.slice(0, 200);
      throw new Error(`OneCLI ${method} ${path} returned ${res.status}${msg ? `: ${msg}` : ''}`);
    }
    return json;
  }

  const enc = encodeURIComponent;

  return {
    async agents(): Promise<GatewayAgent[]> {
      // The listing also carries each agent's gateway access token; keep only metadata.
      return rowsOf(await call('/v1/agents')).map((a) => ({
        id: str(a.id),
        identifier: str(a.identifier),
        name: str(a.name),
      }));
    },

    async findAgent(identifier: string): Promise<GatewayAgent | undefined> {
      return (await this.agents()).find((a) => a.identifier === identifier);
    },

    /** The agent's identity, created when the agent has never run yet (NanoClaw adopts it by identifier). */
    async ensureAgent(identifier: string, name: string): Promise<GatewayAgent> {
      const found = await this.findAgent(identifier);
      if (found) return found;
      const created = (await call('/v1/agents', 'POST', { name, identifier })) as Row;
      return {
        id: str(created.id),
        identifier: str(created.identifier) || identifier,
        name: str(created.name) || name,
      };
    },

    async grants(agentId: string): Promise<AgentGrants> {
      const g = (await call(`/v1/agents/${enc(agentId)}/grants`)) as Row;
      return {
        agentId: str(g.agentId) || agentId,
        connections: rowsOf(g.connections ?? []).map((c) => ({
          connectionId: str(c.connectionId),
          provider: str(c.provider),
          label: str(c.label),
          access: str(c.access),
          allow: strList(c.allow),
          ask: strList(c.ask),
        })),
        secrets: rowsOf(g.secrets ?? []).map((s) => ({ secretId: str(s.secretId), name: str(s.name) })),
      };
    },

    async connections(): Promise<GatewayConnection[]> {
      return rowsOf(await call('/v1/apps/connections'), 'connections').map((c) => ({
        id: str(c.id),
        provider: str(c.provider),
        label: str(c.label),
        status: str(c.status),
      }));
    },

    async secrets(): Promise<GatewaySecret[]> {
      return rowsOf(await call('/v1/secrets')).map((s) => ({
        id: str(s.id),
        name: str(s.name),
        hostPattern: str(s.hostPattern) || null,
      }));
    },

    async appTools(provider: string): Promise<AppTools> {
      const def = (await call(`/v1/apps/${enc(provider)}/permission-definition`)) as Row;
      const categories = rowsOf(def.groups ?? []).map((g) => {
        const wildcard = str(((g.wildcard ?? {}) as Row).id) || undefined;
        return {
          category: str(g.category),
          tools: rowsOf(g.tools ?? []).map((t) => ({ id: str(t.id), name: str(t.name) })),
          ...(wildcard ? { wildcard } : {}),
        };
      });
      const all = categories.flatMap((c) => [...c.tools.map((t) => t.id), ...(c.wildcard ? [c.wildcard] : [])]);
      return { provider, categories, all };
    },

    async attachConnection(agentId: string, connectionId: string, rule: GrantRule): Promise<void> {
      const body =
        rule.access === 'full'
          ? { access: 'full' }
          : { access: 'custom', allow: rule.allow ?? [], ask: rule.ask ?? [] };
      await call(`/v1/agents/${enc(agentId)}/grants/connections/${enc(connectionId)}`, 'PUT', body);
    },

    async detachConnection(agentId: string, connectionId: string): Promise<void> {
      await call(`/v1/agents/${enc(agentId)}/grants/connections/${enc(connectionId)}`, 'DELETE');
    },

    async attachSecret(agentId: string, secretId: string): Promise<void> {
      await call(`/v1/agents/${enc(agentId)}/grants/secrets/${enc(secretId)}`, 'PUT');
    },

    async detachSecret(agentId: string, secretId: string): Promise<void> {
      await call(`/v1/agents/${enc(agentId)}/grants/secrets/${enc(secretId)}`, 'DELETE');
    },
  };
}

export type GrantsClient = ReturnType<typeof grantsClient>;

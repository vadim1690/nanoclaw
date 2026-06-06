/**
 * Integration test for the slack channel's single reach-in: the self-registration
 * import in the `src/channels/index.ts` barrel. Importing the barrel is what runs
 * slack.ts's top-level `registerChannelAdapter('slack', …)`; without the import the
 * channel is silently absent. Delete the `import './slack.js';` line and this goes red.
 *
 * Structural (parse the barrel) rather than behavior (import the barrel and query
 * getRegisteredChannelNames()): slack.ts imports `@chat-adapter/slack` at module
 * load, so importing the barrel would pull that external Chat SDK dependency (and
 * every other installed channel) into the host test process, breaking hermeticity.
 * The registration call is unconditional at the top level of slack.ts, so asserting
 * the barrel line is present guards the integration point.
 *
 * Note on the Chat SDK family: slack.ts also consumes a load-bearing *core* API —
 * `createChatSdkBridge(...)` from ./chat-sdk-bridge.js — with a specific options
 * shape. That core-consumption is a typed call, so the build/typecheck leg
 * (`pnpm run build`) is what guards it against upstream drift, not this test. Every
 * Chat SDK channel (discord, telegram, teams, gchat, webex, …) follows this same
 * shape: swap the module specifier below and the adapter package in the build.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';
import ts from 'typescript';

const BARREL = 'src/channels/index.ts';
const MODULE_SPECIFIER = './slack.js';

function barrelImports(): string[] {
  const p = path.resolve(process.cwd(), BARREL);
  const sf = ts.createSourceFile(p, fs.readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  sf.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
  });
  return specifiers;
}

describe('slack channel registration', () => {
  it(`barrel imports ${MODULE_SPECIFIER} so the adapter self-registers`, () => {
    expect(barrelImports()).toContain(MODULE_SPECIFIER);
  });
});

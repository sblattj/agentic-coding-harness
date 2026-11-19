// Desk role boundaries: the pure classifier (src/desks/boundaries.ts) and the
// "your role, and only this" block every built-in role file opens with.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { formatChatEvent, formatEventLine } from '../src/cli/desk.ts';
import type { HostEvent } from '../src/desks/types.ts';
import { ROLE_BLOCK_HEADING, DIVISION_HEADING, boundaryForTool, toolBaseName } from '../src/desks/boundaries.ts';

const ROOT = resolve(import.meta.dirname, '..');
const DECISIONS = { kind: 'desk' as const, role: 'decisions' };
const LISTENER = { kind: 'desk' as const, role: 'listener' };
const ORCHESTRATOR = { kind: 'desk' as const, role: 'orchestrator' };
const LANE = { kind: 'lane' as const, role: 'lane' };

describe('boundaryForTool: DECISIONS', () => {
  for (const tool of ['edit', 'write', 'bash', 'Edit', 'Bash', 'MultiEdit', 'apply_patch', 'run_shell_command', 'exec_command', 'shell']) {
    it(`warns on ${tool} and names the tool`, () => {
      const w = boundaryForTool(DECISIONS, tool, '');
      assert.ok(w, `expected a warning for ${tool}`);
      assert.equal(w.rule, 'decisions-does-work');
      assert.equal(w.tool, tool);
      assert.match(w.detail, new RegExp(tool.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')));
      assert.match(w.detail, /DECISIONS/);
    });
  }
  it('warns when DECISIONS launches a lane itself', () => {
    const w = boundaryForTool(DECISIONS, 'desks_lane_new', '{"name":"x"}');
    assert.equal(w?.rule, 'decisions-does-work');
    assert.equal(w?.tool, 'desks_lane_new');
  });
  for (const tool of ['desk_send', 'desks_desk_send', 'mcp__desks__desk_send', 'desks_decision_open', 'decision_close', 'desks_desk_roster', 'lane_approve']) {
    it(`no warning for the desk tool ${tool}`, () => {
      assert.equal(boundaryForTool(DECISIONS, tool, '{"to":"ORCHESTRATOR","text":"D1 OWNED by us"}'), null);
    });
  }
  it('matches the role case-insensitively and by role, not by desk name', () => {
    assert.equal(boundaryForTool({ kind: 'desk', role: 'Decisions' }, 'bash', '')?.rule, 'decisions-does-work');
  });
});

describe('boundaryForTool: LISTENER', () => {
  it('warns on a shell tool', () => {
    const w = boundaryForTool(LISTENER, 'bash', 'git push');
    assert.equal(w?.rule, 'listener-does-work');
    assert.equal(w?.tool, 'bash');
  });
  it('warns on an edit tool', () => {
    assert.equal(boundaryForTool(LISTENER, 'write', '')?.rule, 'listener-does-work');
  });
  it('no warning for read-only MCP tools (transcript search, a browser) or desk_send', () => {
    for (const tool of ['whosaid_search', 'cdp_screenshot', 'desks_desk_send', 'read', 'grep', 'webfetch']) {
      assert.equal(boundaryForTool(LISTENER, tool, ''), null, tool);
    }
  });
});

describe('boundaryForTool: ORCHESTRATOR', () => {
  it('no warning for lane tools or desk_send to a desk', () => {
    for (const tool of ['lane_new', 'desks_lane_new', 'desks_lane_status', 'lane_stop', 'lane_approve', 'desks_desk_roster', 'read']) {
      assert.equal(boundaryForTool(ORCHESTRATOR, tool, '{"name":"fix-login"}'), null, tool);
    }
    assert.equal(boundaryForTool(ORCHESTRATOR, 'desks_desk_send', '{"to":"DECISIONS","text":"open: who owns X | ctx | LISTENER"}'), null);
  });
  it('warns when ORCHESTRATOR opens a decision for the human itself', () => {
    const w = boundaryForTool(ORCHESTRATOR, 'desks_decision_open', '{"question":"ship it?"}');
    assert.equal(w?.rule, 'orchestrator-asks-human');
    assert.equal(w?.tool, 'desks_decision_open');
  });
  it('warns when ORCHESTRATOR sends a message to the human', () => {
    const w = boundaryForTool(ORCHESTRATOR, 'mcp__desks__desk_send', '{"to": "human","text":"should I launch it?"}');
    assert.equal(w?.rule, 'orchestrator-asks-human');
    assert.equal(w?.tool, 'mcp__desks__desk_send');
  });
  it('a work tool on ORCHESTRATOR is not a boundary warning (checking evidence may need one)', () => {
    assert.equal(boundaryForTool(ORCHESTRATOR, 'bash', 'ls'), null);
  });
});

describe('boundaryForTool: lanes and custom roles', () => {
  it('a lane may edit, write and run a shell', () => {
    for (const tool of ['edit', 'write', 'bash', 'apply_patch']) assert.equal(boundaryForTool(LANE, tool, ''), null, tool);
  });
  it('a lane is never classified by its role name', () => {
    assert.equal(boundaryForTool({ kind: 'lane', role: 'decisions' }, 'edit', ''), null);
  });
  it('a custom role has no built-in boundary', () => {
    assert.equal(boundaryForTool({ kind: 'desk', role: 'researcher' }, 'bash', ''), null);
  });
});

describe('toolBaseName', () => {
  it('strips claude mcp__server__ and lowercases', () => {
    assert.equal(toolBaseName('mcp__desks__desk_send'), 'desk_send');
    assert.equal(toolBaseName('Bash'), 'bash');
    assert.equal(toolBaseName('desks_lane_new'), 'desks_lane_new');
  });
});

describe('built-in role files', () => {
  const roles = ['orchestrator', 'decisions', 'listener', 'lane'];
  for (const role of roles) {
    it(`roles/${role}.md opens with "${ROLE_BLOCK_HEADING}"`, () => {
      const lines = readFileSync(join(ROOT, 'roles', `${role}.md`), 'utf8').split('\n');
      assert.match(lines[0] ?? '', /^# Role: /);
      const firstH2 = lines.find((l) => l.startsWith('## '));
      assert.equal(firstH2, ROLE_BLOCK_HEADING, `first section of ${role}.md`);
      // nothing but blank lines between the title and the block
      const idx = lines.indexOf(ROLE_BLOCK_HEADING);
      assert.ok(lines.slice(1, idx).every((l) => l.trim() === ''), `${role}.md: the block must come right after the title`);
    });
  }
  it(`roles/common.md holds the division of labor under "${DIVISION_HEADING}"`, () => {
    const text = readFileSync(join(ROOT, 'roles', 'common.md'), 'utf8');
    assert.ok(text.includes(`\n${DIVISION_HEADING}\n`));
    for (const lead of ['**LISTENER hears.**', '**DECISIONS steers.**', '**ORCHESTRATOR orchestrates.**', '**Lanes do the work.**']) {
      assert.ok(text.includes(lead), lead);
    }
    assert.ok(text.includes('`open: <call> | context | asked by`'));
    assert.ok(text.includes('`boundary`'));
  });
  it('no em dash in any built-in role file', () => {
    for (const role of [...roles, 'common']) assert.ok(!readFileSync(join(ROOT, 'roles', `${role}.md`), 'utf8').includes('\u2014'), role);
  });
});

describe('boundary events render in ach desk events and desk chat', () => {
  const w = boundaryForTool(DECISIONS, 'bash', 'rm -rf x');
  const ev: HostEvent = { seq: 7, at: 0, runId: 'r', name: 'DECISIONS', type: 'boundary', data: { ...w } };
  it('formatEventLine names the rule and the tool', () => {
    const line = formatEventLine(ev);
    assert.match(line, /boundary {2}decisions-does-work {2}DECISIONS called the work tool bash/);
  });
  it('formatChatEvent shows it', () => {
    assert.match(formatChatEvent(ev) ?? '', /^ {2}\[boundary\] DECISIONS called the work tool bash/);
  });
});

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { frame, KEY_TABLE, helpSeenPath, keyAction, keyHelpLines, markHelpSeen, shouldShowHelp } from '../src/cli/dash.ts';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'harness-dash-help-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('dash key help (#97)', () => {
  it('overlay lists every key in the table, the glyph legend and the flags', () => {
    const text = keyHelpLines(false, 100).join('\n');
    for (const k of KEY_TABLE) {
      assert.ok(text.includes(k.label), `key ${k.label}`);
      assert.ok(text.includes(k.desc), `desc ${k.desc}`);
    }
    for (const f of ['--all', '--json', '--dir', '--help-keys', '--no-help']) assert.ok(text.includes(f), f);
    assert.match(text, /Status glyphs/);
    assert.match(text, /\*\s+running/);
    assert.match(text, /\+\s+success/);
  });

  it('plain mode has no escape codes; ansi mode does', () => {
    assert.doesNotMatch(keyHelpLines(false, 100).join('\n'), /\x1b/);
    assert.match(keyHelpLines(true, 100).join('\n'), /\x1b\[/);
  });

  it('truncates to the width', () => {
    for (const l of keyHelpLines(false, 20)) assert.ok(l.length <= 20, l);
  });

  it('key table drives dispatch', () => {
    assert.equal(keyAction(0x3f), 'help');
    assert.equal(keyAction(0x71), 'quit');
    assert.equal(keyAction(0x03), 'quit');
    assert.equal(keyAction(0x61), undefined);
  });

  it('first run shows once; second does not; deleting the flag brings it back', () => {
    const d = tmp();
    assert.equal(shouldShowHelp(d, {}), true);
    markHelpSeen(d);
    assert.ok(existsSync(helpSeenPath(d)));
    assert.equal(shouldShowHelp(d, {}), false);
    unlinkSync(helpSeenPath(d));
    assert.equal(shouldShowHelp(d, {}), true);
  });

  it('--help-keys always shows; --no-help never auto-shows', () => {
    const d = tmp();
    assert.equal(shouldShowHelp(d, { noHelp: true }), false);
    markHelpSeen(d);
    assert.equal(shouldShowHelp(d, { helpKeys: true }), true);
    assert.equal(shouldShowHelp(d, { helpKeys: true, noHelp: true }), true);
  });

  it('markHelpSeen creates a missing state dir', () => {
    const d = join(tmp(), 'nested', 'state');
    markHelpSeen(d);
    assert.ok(existsSync(helpSeenPath(d)));
  });

  it('footer advertises ? help beside q quit', () => {
    assert.match(frame([], '/x', false, 120, false), /\? help {2}q quit/);
  });
});

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  StateDetector,
  TokenScraper,
  watchLoop,
  CLAUDE_RULES,
  OPENCODE_RULES,
  KIRO_RULES,
} from '../src/monitors/tmux-driver.ts';

const CLAUDE_RUNNING_PANE = `
     ⎿  Wrote src/monitors/tmux-driver.ts with 120 lines

  ✻ Cerebrating… (esc to interrupt · 12s · ↓ 1.2k tokens · ↑ 340 tokens · opus)
`;

const CLAUDE_WAITING_PANE = `
╭──────────────────────────────────────────────╮
│ Do you want to proceed?                      │
│ ❯ 1. Yes                                     │
│   2. No, and tell Claude what to do          │
╰──────────────────────────────────────────────╯
`;

const CLAUDE_IDLE_PANE = `
⏵⏵ accept edits on (shift+tab to cycle)
✻ Ready for your next task
`;

const OPENCODE_RUNNING_PANE = `
4 msgs | 12 tools
└ esc to interrupt · 42s
`;

const OPENCODE_WAITING_PANE = `
△ Permission required: bash (npm test)
  Allow once / Allow always / Deny
`;

const SCROLLBACK_PANE = [
  '│ Do you want to proceed? (old prompt, long scrolled away)',
  '⎿  Read src/a.ts',
  '⎿  Read src/b.ts',
  '⎿  Read src/c.ts',
  '⎿  Read src/d.ts',
  '⎿  Read src/e.ts',
  '⎿  Read src/f.ts',
  '⎿  Read src/g.ts',
  '✻ Ready for your next task',
].join('\n');

describe('StateDetector / CLAUDE_RULES', () => {
  const detector = new StateDetector(CLAUDE_RULES);

  test('classifies a running pane', () => {
    const result = detector.detect(CLAUDE_RUNNING_PANE);
    assert.equal(result.state, 'running');
    assert.equal(result.matchedRule?.state, 'running');
  });

  test('classifies a permission prompt as waiting', () => {
    assert.equal(detector.detect(CLAUDE_WAITING_PANE).state, 'waiting');
  });

  test('classifies an idle pane', () => {
    assert.equal(detector.detect(CLAUDE_IDLE_PANE).state, 'idle');
  });

  test('waiting outranks running when both patterns are visible', () => {
    const pane = `${CLAUDE_WAITING_PANE}\n  ✻ Deliberating… (esc to interrupt · 3s)\n`;
    assert.equal(detector.detect(pane).state, 'waiting');
  });

  test('bottom-scoped rules ignore matches in scrollback', () => {
    assert.equal(detector.detect(SCROLLBACK_PANE).state, 'idle');
  });
});

describe('StateDetector / OPENCODE_RULES', () => {
  const detector = new StateDetector(OPENCODE_RULES);

  test('classifies a running pane', () => {
    assert.equal(detector.detect(OPENCODE_RUNNING_PANE).state, 'running');
  });

  test('classifies a permission prompt as waiting', () => {
    assert.equal(detector.detect(OPENCODE_WAITING_PANE).state, 'waiting');
  });

  test('defaults to idle with no matchedRule on unknown panes', () => {
    const result = detector.detect('nothing to see here\njust text\n');
    assert.deepEqual(result, { state: 'idle' });
  });
});

describe('StateDetector / KIRO_RULES', () => {
  const detector = new StateDetector(KIRO_RULES);

  test('generic y/n prompt counts as waiting', () => {
    assert.equal(detector.detect('Accept this change? [Y/n]').state, 'waiting');
  });

  test('generic progress wording counts as running', () => {
    assert.equal(detector.detect('Working on it…').state, 'running');
  });
});

describe('StateDetector rule mechanics', () => {
  test('priority beats list order', () => {
    const detector = new StateDetector([
      { state: 'running', pattern: /token/, region: 'anywhere', priority: 1 },
      { state: 'waiting', pattern: /token/, region: 'anywhere', priority: 9 },
    ]);
    assert.equal(detector.detect('↓ 5k tokens').state, 'waiting');
  });

  test('ties resolve to the earlier-listed rule', () => {
    const detector = new StateDetector([
      { state: 'running', pattern: /same/, region: 'anywhere', priority: 5 },
      { state: 'waiting', pattern: /same/, region: 'anywhere', priority: 5 },
    ]);
    assert.equal(detector.detect('same').state, 'running');
  });

  test('rules without a region default to anywhere', () => {
    const detector = new StateDetector([
      { state: 'waiting', pattern: /urgent/, priority: 10 },
    ]);
    const pane = ['urgent', 'filler', 'filler', 'filler', 'filler', 'filler'].join('\n');
    assert.equal(detector.detect(pane).state, 'waiting');
  });
});

describe('TokenScraper', () => {
  const scraper = new TokenScraper();

  test('sums the k-suffixed and plain counts on a claude status line', () => {
    const reading = scraper.scrape(CLAUDE_RUNNING_PANE);
    assert.equal(reading.tokens, 1200 + 340);
    assert.equal(reading.raw, '↑ 340 tokens');
  });

  test('parses m suffix', () => {
    assert.equal(scraper.scrape('↓ 2.5m tokens\n').tokens, 2_500_000);
  });

  test('parses comma-grouped numbers', () => {
    assert.equal(scraper.scrape('↑ 3,456 tokens\n').tokens, 3456);
  });

  test('returns empty reading when no token readout is visible', () => {
    assert.deepEqual(scraper.scrape(CLAUDE_IDLE_PANE), {});
  });

  test('ignores token readouts outside the bottom region', () => {
    const pane = ['↓ 9m tokens (scrolled away)', 'filler', 'filler', 'filler', 'filler', 'filler'].join('\n');
    assert.deepEqual(scraper.scrape(pane), {});
  });
});

describe('watchLoop', () => {
  class FakeDriver {
    private idx = 0;
    private readonly panes: string[];
    constructor(panes: string[]) {
      this.panes = panes;
    }
    capture(_opts?: { last?: number }): string {
      const pane = this.panes[Math.min(this.idx, this.panes.length - 1)];
      this.idx++;
      return pane as string;
    }
  }

  test('emits once per state transition and stops cleanly', async () => {
    const seen: string[] = [];
    const driver = new FakeDriver([
      CLAUDE_IDLE_PANE,
      CLAUDE_IDLE_PANE + '\n',                       // same state, different text
      CLAUDE_RUNNING_PANE,
      CLAUDE_RUNNING_PANE.replace('12s', '13s'),     // same state, different text
      CLAUDE_WAITING_PANE,
    ]);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('watchLoop never reached waiting')), 2000);
      let handle: ReturnType<typeof watchLoop>;
      handle = watchLoop(driver, new StateDetector(CLAUDE_RULES), {
        intervalMs: 5,
        onChange: (state) => {
          seen.push(state);
          if (state === 'waiting') {
            clearTimeout(timeout);
            handle.stop();
            resolve();
          }
        },
      });
    });

    assert.deepEqual(seen, ['idle', 'running', 'waiting']);
  });

  test('survives transient capture errors and keeps the last state', async () => {
    let failures = 0;
    const errors: unknown[] = [];
    const seen: string[] = [];
    const good = new FakeDriver([CLAUDE_IDLE_PANE, CLAUDE_WAITING_PANE]);
    const driver = {
      capture(opts?: { last?: number }) {
        if (failures++ === 0) throw new Error('tmux: transient socket hiccup');
        return good.capture(opts);
      },
    };

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('watchLoop never reached waiting')), 2000);
      let handle: ReturnType<typeof watchLoop>;
      handle = watchLoop(driver, new StateDetector(CLAUDE_RULES), {
        intervalMs: 5,
        onError: (err) => errors.push(err),
        onChange: (state) => {
          seen.push(state);
          if (state === 'waiting') {
            clearTimeout(timeout);
            handle.stop();
            resolve();
          }
        },
      });
    });

    assert.equal(errors.length, 1);
    assert.deepEqual(seen, ['idle', 'waiting']);
  });
});

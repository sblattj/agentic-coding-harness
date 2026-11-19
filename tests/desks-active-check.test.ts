// runActiveCheck is the call check behind `desk status`, the live-call refusal of `desk off`,
// the auto watcher and the host's automatic reload. A malformed answer must count as unknown
// (reject), never as "no call", or ach can stop a desk during a live call.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runActiveCheck } from '../src/desks/feeds.ts';

const printing = (json: string): string[] => ['/bin/echo', json];

describe('runActiveCheck', () => {
  it('reads a boolean active field', async () => {
    assert.equal(await runActiveCheck(printing('{"active": true}')), true);
    assert.equal(await runActiveCheck(printing('{"active": false}')), false);
  });

  it('rejects an object without a boolean active field instead of reading it as no call', async () => {
    for (const json of ['{}', '{"active": "yes"}', '{"active": 1}', '{"active": null}', '{"live": true}']) {
      await assert.rejects(runActiveCheck(printing(json)), /active/, `${json} must count as unknown`);
    }
  });

  it('rejects output that is not a JSON object', async () => {
    for (const json of ['not json', '[]', 'true']) {
      await assert.rejects(runActiveCheck(printing(json)), /activeCheck printed no JSON/, `${json} must count as unknown`);
    }
  });
});

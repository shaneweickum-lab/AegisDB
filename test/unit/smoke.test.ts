import { test } from 'node:test';
import assert from 'node:assert/strict';

test('test harness runs TypeScript directly via strip-types', () => {
  const x: number = 2 + 2;
  assert.equal(x, 4);
});

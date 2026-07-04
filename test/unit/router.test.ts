import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../../src/server/router.ts';

test('matches an exact literal path', () => {
  const router = new Router();
  router.add('GET', '/api/health', () => ({ status: 200 }));
  const match = router.match('GET', '/api/health');
  assert.ok(match);
  assert.equal(match!.requireAuth, false);
});

test('does not match a different method on the same path', () => {
  const router = new Router();
  router.add('GET', '/api/health', () => ({ status: 200 }));
  assert.equal(router.match('POST', '/api/health'), null);
});

test('captures :param segments', () => {
  const router = new Router();
  router.add('GET', '/api/collections/:collection/documents/:id', () => ({ status: 200 }));
  const match = router.match('GET', '/api/collections/notes/documents/abc123');
  assert.ok(match);
  assert.deepEqual(match!.params, { collection: 'notes', id: 'abc123' });
});

test('does not match a path with a different segment count', () => {
  const router = new Router();
  router.add('GET', '/api/collections/:collection/documents/:id', () => ({ status: 200 }));
  assert.equal(router.match('GET', '/api/collections/notes/documents'), null);
});

test('decodes URL-encoded param values', () => {
  const router = new Router();
  router.add('GET', '/api/collections/:collection/documents/:id', () => ({ status: 200 }));
  const match = router.match('GET', '/api/collections/notes/documents/a%2Fb');
  assert.equal(match!.params.id, 'a/b');
});

test('requireAuth is carried through from route registration', () => {
  const router = new Router();
  router.add('GET', '/public', () => ({ status: 200 }));
  router.add('GET', '/private', () => ({ status: 200 }), { auth: true });
  assert.equal(router.match('GET', '/public')!.requireAuth, false);
  assert.equal(router.match('GET', '/private')!.requireAuth, true);
});

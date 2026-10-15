// Unit tests for the controller-side DKIM key validator. A key truncated by the
// old mail-node parsing bug is still valid base64 with a "p=", but must be
// rejected because it does not decode to a complete RSA public key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { isValidDkimPublicKey } from './services/DkimKey.js';

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const FULL = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

test('accepts a complete 2048-bit RSA public key', () => {
  assert.equal(FULL.length, 392);
  assert.equal(isValidDkimPublicKey(FULL), true);
});

test('rejects a key truncated at the first DNS character-string (~250 chars)', () => {
  assert.equal(isValidDkimPublicKey(FULL.slice(0, 250)), false);
});

test('rejects empty, whitespace, and non-base64 input', () => {
  assert.equal(isValidDkimPublicKey(''), false);
  assert.equal(isValidDkimPublicKey('   '), false);
  assert.equal(isValidDkimPublicKey(null), false);
  assert.equal(isValidDkimPublicKey(undefined), false);
  assert.equal(isValidDkimPublicKey('not!base64!!'), false);
});

test('tolerates surrounding whitespace inside an otherwise-valid key', () => {
  const spaced = FULL.slice(0, 100) + '\n ' + FULL.slice(100);
  assert.equal(isValidDkimPublicKey(spaced), true);
});

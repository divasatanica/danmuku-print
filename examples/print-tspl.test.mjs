import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTestLabel } from './print-tspl.mjs';

test('builds one TSPL label with CRLF and no BOM', () => {
  const expected = 'SIZE 50 mm,30 mm\r\nGAP 2 mm,0 mm\r\nCLS\r\n'
    + 'TEXT 24,24,"3",0,1,1,"TSPL TEST"\r\nPRINT 1,1\r\n';
  assert.deepEqual(makeTestLabel(), Buffer.from(expected, 'ascii'));
});

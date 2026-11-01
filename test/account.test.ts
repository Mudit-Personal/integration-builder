import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialsOf } from '../web/src/api.ts';

const of = (email: string, name = '') => initialsOf({ email, name });

test('initials come from the name, or from the words of the email when there is no name', () => {
  assert.equal(of('mudit.mittal@postman.com'), 'MM');
  assert.equal(of('ana_de-la+cruz@x.io'), 'AC');
  assert.equal(of('sam@x.io'), 'S');
  assert.equal(of('demo1793554502@acme.com'), 'D');
  assert.equal(of('42@x.io'), '?');
  assert.equal(of('x@x.io', 'Ana de la Cruz'), 'AC');
  assert.equal(of('x@x.io', '  émile '), 'É');
});

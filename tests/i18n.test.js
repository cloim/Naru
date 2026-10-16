import assert from 'node:assert/strict';
import test from 'node:test';
import english from '../src/locales/en.js';
import {
  LANGUAGE_KEY,
  readLanguage,
  getLanguage,
  setLanguage,
  subscribeLanguage,
  translate,
  formatDate,
} from '../src/locale.js';

test('English is the default for new, invalid and restricted storage', () => {
  assert.equal(readLanguage({ getItem: () => null }), 'en');
  assert.equal(readLanguage({ getItem: () => 'fr' }), 'en');
  assert.equal(
    readLanguage({
      getItem: () => {
        throw Error('restricted');
      },
    }),
    'en',
  );
  assert.equal(readLanguage({ getItem: () => 'ko' }), 'ko');
});

test('language selection persists, notifies subscribers and updates document language', () => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const saved = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => saved.get(key),
      setItem: (key, value) => saved.set(key, value),
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: {} },
  });
  let updates = 0;
  const unsubscribe = subscribeLanguage(() => updates++);
  try {
    setLanguage('ko');
    assert.equal(getLanguage(), 'ko');
    assert.equal(saved.get(LANGUAGE_KEY), 'ko');
    assert.equal(readLanguage(), 'ko');
    assert.equal(document.documentElement.lang, 'ko');
    assert.equal(translate('설정'), '설정');
    assert.equal(
      formatDate('2026-10-16T01:02:03Z'),
      new Date('2026-10-16T01:02:03Z').toLocaleString('ko-KR'),
    );
    setLanguage('en');
    assert.equal(translate('설정'), 'Settings');
    assert.equal(updates, 2);
    assert.throws(() => setLanguage('ja'), /Unsupported language/);
    assert.equal(getLanguage(), 'en');
    unsubscribe();
    setLanguage('en');
    assert.equal(updates, 2);
  } finally {
    unsubscribe();
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else delete globalThis.localStorage;
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
    else delete globalThis.document;
  }
});

test('storage denial still allows switching language', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw Error('restricted');
    },
  });
  try {
    setLanguage('ko');
    assert.equal(getLanguage(), 'ko');
    setLanguage('en');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('translations preserve placeholders and substitute user data exactly once', () => {
  for (const [source, translation] of Object.entries(english)) {
    assert.ok(translation.trim(), source);
    assert.deepEqual(
      [...translation.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort(),
      [...source.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort(),
      source,
    );
  }
  assert.equal(
    translate('{0} 프로젝트 시작', ['my-{1}-프로젝트'], 'en'),
    'Start project my-{1}-프로젝트',
  );
  assert.equal(translate('{0} 프로젝트 시작', ['my-project'], 'ko'), 'my-project 프로젝트 시작');
  assert.equal(translate('custom image/name:v1', [], 'en'), 'custom image/name:v1');
  assert.equal(translate(undefined), undefined);
});

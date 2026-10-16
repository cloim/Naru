import english from './locales/en.js';

export const LANGUAGE_KEY = 'naru.language';
export const languages = [
  ['en', 'English'],
  ['ko', '한국어'],
];
const listeners = new Set();
export function readLanguage(storage) {
  try {
    return (storage ?? globalThis.localStorage)?.getItem(LANGUAGE_KEY) === 'ko' ? 'ko' : 'en';
  } catch {
    return 'en';
  }
}
let language = readLanguage();
export const getLanguage = () => language;
export function subscribeLanguage(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function setLanguage(next) {
  if (!languages.some(([code]) => code === next)) throw new Error(`Unsupported language: ${next}`);
  language = next;
  try {
    globalThis.localStorage?.setItem(LANGUAGE_KEY, next);
  } catch {
    // Browser policy may disable storage. The selection still works for this session.
  }
  if (globalThis.document) document.documentElement.lang = next;
  listeners.forEach((listener) => listener());
}
export function translate(source, values = [], locale = language) {
  if (source == null) return source;
  const message = locale === 'en' ? (english[source] ?? source) : source;
  return message.replace(/\{(\d+)\}/g, (token, index) =>
    index < values.length ? String(values[index]) : token,
  );
}
export function formatDate(value) {
  return new Date(value).toLocaleString(language === 'ko' ? 'ko-KR' : 'en-US');
}

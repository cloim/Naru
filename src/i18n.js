import { useSyncExternalStore } from 'react';
import { getLanguage, subscribeLanguage } from './locale.js';

export { translate as t, setLanguage, languages, formatDate } from './locale.js';
export function useLocale() {
  return useSyncExternalStore(subscribeLanguage, getLanguage, () => 'en');
}

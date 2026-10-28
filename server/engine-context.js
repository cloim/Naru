import { AsyncLocalStorage } from 'node:async_hooks';

export const engineContext = new AsyncLocalStorage();
export const target = () => engineContext.getStore() || { id: 'local', name: '로컬 WSL' };
export const engineKey = () => target().scopeId || target().id;
export const remoteTarget = () => target().id !== 'local';
export function localOnly() {
  if (remoteTarget()) throw new Error('로컬 WSL 전용 기능입니다. 로컬 엔진을 선택해 주세요.');
}

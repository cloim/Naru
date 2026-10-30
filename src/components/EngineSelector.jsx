import React, { useState } from 'react';
import { api, engineBinding } from '../api.js';
import { useData, useActions } from '../ui.jsx';
import SelectControl from './SelectControl/SelectControl.tsx';
import { Tooltip } from './Tooltip.jsx';
import { t } from '../i18n.js';

// 연결 대상과 연결 상태를 한 줄로 보여 준다. 점의 색과 오른쪽 문구가 같은 상태를 나타낸다.
export function EngineSelector() {
  const cfg = useData('engines', '/engines');
  const binding = useData('engine-binding', '/engines', { queryFn: engineBinding });
  const { status, notify } = useActions();
  const [switching, setSwitching] = useState(false);
  const stateLabel = status?.ready
    ? t('연결됨')
    : status?.error
      ? t('연결 실패')
      : t('연결 확인 중');
  return (
    <div className="relative mb-5 flex h-11 flex-none items-center rounded-[10px] bg-[#ffffff0d] transition-colors hover:bg-[#ffffff14]">
      <Tooltip content={stateLabel} side="right">
        <span
          role="status"
          aria-label={stateLabel}
          tabIndex={0}
          className="absolute top-1/2 left-2 z-1 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-[#a8c69b]"
        >
          <span
            aria-hidden="true"
            className={`h-2 w-2 rounded-full ${status?.ready ? 'bg-[#6ccf8e] shadow-[0_0_0_3px_rgba(108,207,142,0.2)]' : status?.error ? 'bg-[#e7a69c]' : 'animate-pulse bg-[#a9bdb1]'}`}
          />
        </span>
      </Tooltip>
      {!cfg.data || !binding.data ? (
        <div
          className="flex items-center gap-3 pl-9"
          aria-busy="true"
          aria-label={t('연결 확인 중')}
        >
          <span className="h-3 w-22 animate-pulse rounded bg-[#ffffff16]" />
        </div>
      ) : (
        <SelectControl
          id="engine-selector"
          aria-label={t('연결 대상')}
          className="h-11 w-full truncate rounded-[10px] border-0 bg-transparent pr-8 pl-9 text-[13px] font-semibold text-[#f1ffdf] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#a8c69b] [&_option]:bg-brand [&_option]:text-[#f1ffdf]"
          wrapperClassName="w-full text-[#b8cec2]"
          value={binding.data.id}
          disabled={switching}
          onChange={async (e) => {
            setSwitching(true);
            try {
              await api('/engines/selection/current', {
                method: 'PUT',
                body: { id: e.target.value },
              });
              window.location.assign('/');
            } catch (err) {
              notify(err);
              setSwitching(false);
            }
          }}
        >
          <option value="local">{t('로컬 WSL')}</option>
          {cfg.data.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </SelectControl>
      )}
    </div>
  );
}

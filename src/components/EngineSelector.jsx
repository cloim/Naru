import React, { useState } from 'react';
import { Monitor, Server } from 'lucide-react';
import { api, engineBinding } from '../api.js';
import { useData, useActions } from '../ui.jsx';
import SelectControl from './SelectControl/SelectControl.tsx';
import { Tooltip } from './Tooltip.jsx';
import { t } from '../i18n.js';

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
  const EngineIcon = binding.data?.id === 'local' ? Monitor : Server;
  return (
    <div className="mb-5 flex-none rounded-[9px] border border-[#ffffff16] bg-[#ffffff05] p-1">
      <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-1">
        <label htmlFor="engine-selector" className="text-[11px] font-medium text-[#b8cec2]">
          {t('연결 대상')}
        </label>
        <Tooltip content={stateLabel} side="right">
          <span
            role="status"
            aria-label={stateLabel}
            tabIndex={0}
            className="flex h-4 w-4 items-center justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-[#a8c69b]"
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${status?.ready ? 'bg-lime' : status?.error ? 'bg-[#e7a69c]' : 'animate-pulse bg-[#a9bdb1]'}`}
            />
          </span>
        </Tooltip>
      </div>
      {!cfg.data || !binding.data ? (
        <div
          className="flex h-11 items-center gap-3 px-3"
          aria-busy="true"
          aria-label={t('연결 확인 중')}
        >
          <span className="h-4 w-4 animate-pulse rounded bg-[#ffffff16]" />
          <span className="h-3 w-22 animate-pulse rounded bg-[#ffffff16]" />
        </div>
      ) : (
        <div className="relative">
          <EngineIcon
            size={16}
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 z-1 -translate-y-1/2 text-[#b8cec2]"
          />
          <SelectControl
            id="engine-selector"
            className="h-11 w-full truncate rounded-[6px] border-0 bg-transparent pl-9 text-[13px] font-medium text-[#f1ffdf] transition-colors hover:bg-[#ffffff0b] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#a8c69b] [&_option]:bg-brand [&_option]:text-[#f1ffdf]"
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
        </div>
      )}
    </div>
  );
}

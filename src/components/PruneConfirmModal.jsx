import React, { useMemo } from 'react';
import { Trash2, CheckCircle2, AlertTriangle, Layers, HardDrive, Network } from 'lucide-react';
import { t, useLocale } from '../i18n.js';
import { useData, Button, Skeleton, ErrorState, bytes } from '../ui.jsx';
import { Modal } from './Modal/Modal.jsx';
import { cn } from '../tw.js';

export function PruneConfirmModal({ isOpen, onClose, kind, onConfirm, busy }) {
  useLocale();

  const preview = useData(
    ['prune-preview', kind],
    `/${kind}/prune-preview`,
    {
      enabled: isOpen,
      staleTime: 0,
      refetchOnWindowFocus: false,
    },
  );

  const items = preview.data || [];

  const titles = {
    images: t('미사용 이미지 정리 대상 확인'),
    volumes: t('미사용 볼륨 정리 대상 확인'),
    networks: t('미사용 네트워크 정리 대상 확인'),
  };

  const labels = {
    images: t('이미지'),
    volumes: t('볼륨'),
    networks: t('네트워크'),
  };

  const icons = {
    images: Layers,
    volumes: HardDrive,
    networks: Network,
  };

  const Icon = icons[kind] || Layers;

  const totalSize = useMemo(() => {
    if (kind !== 'images') return 0;
    return items.reduce((acc, curr) => acc + (curr.size || 0), 0);
  }, [items, kind]);

  const isEmpty = !preview.isLoading && !preview.error && items.length === 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={titles[kind] || t('미사용 정리 대상 확인')}
      size="md"
      footer={
        <div className="flex w-full items-center justify-end gap-2.5">
          <Button onClick={onClose} disabled={busy}>
            {isEmpty ? t('닫기') : t('취소')}
          </Button>
          {!isEmpty && (
            <Button
              className="border-[#c93b2b] bg-[#c93b2b] text-white enabled:hover:bg-[#b03022]"
              icon={Trash2}
              disabled={busy || preview.isLoading || !!preview.error}
              onClick={onConfirm}
            >
              {t('{0}개 정리 실행', [items.length])}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4 text-[13px] text-ink">
        {preview.isLoading ? (
          <div className="py-8">
            <Skeleton />
          </div>
        ) : preview.error ? (
          <ErrorState error={preview.error} retry={() => preview.refetch()} />
        ) : isEmpty ? (
          <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
            <CheckCircle2 size={40} className="text-[#3b7c4b]" />
            <div className="flex flex-col gap-1">
              <strong className="text-[15px] text-ink">
                {t('정리할 미사용 {0}이(가) 없습니다', [labels[kind]])}
              </strong>
              <p className="text-[12px] text-muted">
                {t(
                  '모든 {0}이(가) 현재 실행 중이거나 중지된 컨테이너에 연결되어 있어 안전하게 유지됩니다.',
                  [labels[kind]],
                )}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2.5 rounded-[8px] border border-[#f0dfbe] bg-[#fdfaf3] p-3 text-[12px] text-[#785b20]">
              <AlertTriangle size={16} className="mt-0.5 flex-none text-[#b88626]" />
              <div className="flex flex-col gap-0.5">
                <strong>{t('연결된 컨테이너가 없는 미사용 항목만 정리됩니다')}</strong>
                <span>
                  {t(
                    '중지된 컨테이너라도 연결되어 있는 리소스는 보존되며, 아래 목록의 {0}개 항목만 영구 삭제됩니다.',
                    [items.length],
                  )}
                </span>
              </div>
            </div>

            <div className="flex max-h-[280px] flex-col overflow-y-auto rounded-[8px] border border-line bg-[#fdfefc]">
              <table className="w-full text-left border-collapse text-[12px]">
                <thead className="sticky top-0 bg-[#f4f7f1] border-b border-line text-muted">
                  <tr>
                    <th className="py-2 px-3 font-semibold">{t('이름')}</th>
                    {kind === 'images' && <th className="py-2 px-3 font-semibold w-28">{t('크기')}</th>}
                    {kind === 'volumes' && <th className="py-2 px-3 font-semibold w-28">{t('드라이버')}</th>}
                    {kind === 'networks' && <th className="py-2 px-3 font-semibold w-28">{t('드라이버')}</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {items.map((item, idx) => (
                    <tr key={item.id || item.name || idx} className="hover:bg-[#f6f9f3]">
                      <td className="py-2 px-3">
                        <div className="flex items-center gap-2">
                          <Icon size={14} className="flex-none text-muted" />
                          <div className="flex flex-col min-w-0">
                            <span className="font-mono text-ink truncate font-medium">
                              {item.name}
                            </span>
                            {item.id && (
                              <span className="font-mono text-[10px] text-muted">
                                {item.id}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      {kind === 'images' && (
                        <td className="py-2 px-3 font-mono text-muted">
                          {bytes(item.size)}
                        </td>
                      )}
                      {kind === 'volumes' && (
                        <td className="py-2 px-3 font-mono text-muted">
                          {item.driver || 'local'}
                        </td>
                      )}
                      {kind === 'networks' && (
                        <td className="py-2 px-3 font-mono text-muted">
                          {item.driver || 'bridge'}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between px-1 text-[12px] text-muted">
              <span>{t('총 {0}개 미사용 항목', [items.length])}</span>
              {kind === 'images' && totalSize > 0 && (
                <span>
                  {t('확보 예상 용량')}: <strong className="text-ink">{bytes(totalSize)}</strong>
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

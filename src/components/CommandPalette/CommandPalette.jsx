import { t, useLocale } from '../../i18n.js';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  Box,
  Layers,
  HardDrive,
  Network,
  Settings2,
  Activity,
  History,
  Camera,
  ArrowUpRight,
  ShipWheel,
  Puzzle,
  Sparkles,
  Plus,
  FolderPlus,
  ArrowRight,
} from 'lucide-react';
import { useActions, useData, containerName } from '../../ui.jsx';
import { cn } from '../../tw.js';

export function CommandPalette({ isOpen, onClose, onOpenCreate, onPrune }) {
  useLocale();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const { status } = useActions();

  const containers = useData('containers', '/containers', {
    enabled: isOpen && !!status?.ready,
  });

  const staticItems = useMemo(
    () => [
      {
        id: 'nav-containers',
        category: t('이동'),
        label: t('컨테이너'),
        subtext: '/',
        icon: Box,
        action: () => navigate('/'),
      },
      {
        id: 'nav-images',
        category: t('이동'),
        label: t('이미지'),
        subtext: '/images',
        icon: Layers,
        action: () => navigate('/images'),
      },
      {
        id: 'nav-k8s',
        category: t('이동'),
        label: 'Kubernetes',
        subtext: '/kubernetes',
        icon: ShipWheel,
        action: () => navigate('/kubernetes'),
      },
      {
        id: 'nav-ports',
        category: t('이동'),
        label: t('포트 전달'),
        subtext: '/ports',
        icon: ArrowUpRight,
        action: () => navigate('/ports'),
      },
      {
        id: 'nav-volumes',
        category: t('이동'),
        label: t('볼륨'),
        subtext: '/volumes',
        icon: HardDrive,
        action: () => navigate('/volumes'),
      },
      {
        id: 'nav-networks',
        category: t('이동'),
        label: t('네트워크'),
        subtext: '/networks',
        icon: Network,
        action: () => navigate('/networks'),
      },
      {
        id: 'nav-snapshots',
        category: t('이동'),
        label: t('스냅샷'),
        subtext: '/snapshots',
        icon: Camera,
        action: () => navigate('/snapshots'),
      },
      {
        id: 'nav-extensions',
        category: t('이동'),
        label: t('확장'),
        subtext: '/extensions',
        icon: Puzzle,
        action: () => navigate('/extensions'),
      },
      {
        id: 'nav-jobs',
        category: t('이동'),
        label: t('작업 기록'),
        subtext: '/jobs',
        icon: History,
        action: () => navigate('/jobs'),
      },
      {
        id: 'nav-diagnostics',
        category: t('이동'),
        label: t('진단'),
        subtext: '/diagnostics',
        icon: Activity,
        action: () => navigate('/diagnostics'),
      },
      {
        id: 'nav-settings',
        category: t('이동'),
        label: t('설정'),
        subtext: '/settings',
        icon: Settings2,
        action: () => navigate('/settings'),
      },
      {
        id: 'act-create',
        category: t('작업'),
        label: t('컨테이너 실행'),
        subtext: t('새 컨테이너 생성 및 시작'),
        icon: Plus,
        action: () => {
          navigate('/');
          onOpenCreate?.();
        },
      },
      {
        id: 'act-prune',
        category: t('작업'),
        label: t('미사용 리소스 정리'),
        subtext: t('중지된 컨테이너 및 미사용 이미지 일괄 정리'),
        icon: Sparkles,
        action: () => {
          navigate('/');
          onPrune?.();
        },
      },
    ],
    [navigate, onOpenCreate, onPrune],
  );

  const containerItems = useMemo(() => {
    if (!containers.data || !Array.isArray(containers.data)) return [];
    return containers.data.map((c) => {
      const name = containerName(c);
      return {
        id: 'container-' + c.Id,
        category: t('컨테이너'),
        label: name,
        subtext: `${c.Id?.slice(0, 12)} | ${c.State}`,
        icon: Box,
        action: () => navigate('/containers/' + c.Id),
      };
    });
  }, [containers.data, navigate]);

  const allItems = useMemo(
    () => [...staticItems, ...containerItems],
    [staticItems, containerItems],
  );

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allItems;
    return allItems.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q) ||
        (item.subtext && item.subtext.toLowerCase().includes(q)),
    );
  }, [allItems, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => (filteredItems.length ? (prev + 1) % filteredItems.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) =>
        filteredItems.length ? (prev - 1 + filteredItems.length) % filteredItems.length : 0,
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredItems[activeIndex]) {
        filteredItems[activeIndex].action();
        onClose();
      }
    }
  };

  useEffect(() => {
    if (listRef.current) {
      const el = listRef.current.children[activeIndex];
      el?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-200 flex items-start justify-center bg-[#102c2466] p-4 pt-18 backdrop-blur-xs max-tablet:pt-10"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-[560px] flex-col overflow-hidden rounded-[14px] border border-[#d6ded5] bg-[#fafbf7] shadow-2xl animate-in fade-in zoom-in-95 duration-100"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex h-13 items-center gap-3 border-b border-[#e3e8df] bg-white px-4">
          <Search size={18} className="text-[#8c978e]" />
          <input
            ref={inputRef}
            className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-0 placeholder:text-[#9aa29b]"
            placeholder={t('페이지 이동, 컨테이너 검색, 작업 실행…')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="rounded bg-[#f0f2ee] px-1.5 py-0.5 text-[10px] font-mono text-[#7a837c]">
            ESC
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[360px] overflow-y-auto p-1.5">
          {filteredItems.length === 0 ? (
            <div className="p-8 text-center text-[13px] text-[#8c978e]">
              {t('검색 결과가 없습니다.')}
            </div>
          ) : (
            filteredItems.map((item, idx) => {
              const Icon = item.icon;
              const isSelected = idx === activeIndex;
              return (
                <div
                  key={item.id}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-[8px] px-3 py-2.5 text-[13px] transition-colors',
                    isSelected ? 'bg-[#e7f0e0] text-[#2c533e]' : 'text-ink hover:bg-[#f0f4ea]',
                  )}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => {
                    item.action();
                    onClose();
                  }}
                >
                  <Icon
                    size={17}
                    className={cn(isSelected ? 'text-[#356d4c]' : 'text-[#7a857c]')}
                  />
                  <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                    <span className="truncate font-medium">{item.label}</span>
                    {item.subtext && (
                      <span className="truncate font-mono text-[11px] text-[#8c978e]">
                        {item.subtext}
                      </span>
                    )}
                  </div>
                  <span className="rounded bg-[#e8eee4] px-1.5 py-0.5 text-[10px] font-semibold text-[#5a705e]">
                    {item.category}
                  </span>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[#e3e8df] bg-[#f4f7f0] px-4 py-2 text-[11px] text-[#7a857c]">
          <span>{t('선택: ↑↓ | 실행: Enter | 닫기: ESC')}</span>
          <span className="font-mono">{t('{0}개 항목', [filteredItems.length])}</span>
        </div>
      </div>
    </div>
  );
}

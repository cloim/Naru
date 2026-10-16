import React, { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { Puzzle, Plus, Trash2, ChevronRight, ArrowLeft } from 'lucide-react';
import {
  Button,
  IconButton,
  Empty,
  ErrorState,
  Skeleton,
  useData,
  useActions,
  PageActions,
  PageAction,
  usePageTitle,
} from '../ui.jsx';
import { cn, tw } from '../tw.js';
import { api } from '../api.js';

export default function Extensions() {
  const { id } = useParams(),
    navigate = useNavigate(),
    frame = useRef();
  const { job, form, confirm, notify, busy, status } = useActions();
  const data = useData('extensions', '/extensions');
  const session = useQuery({
    queryKey: ['extension-session', id],
    queryFn: () => api(`/extensions/${id}/session`, { method: 'POST', body: {} }),
    enabled: !!id,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  usePageTitle(id ? session.data?.title || '확장' : null);
  useEffect(() => {
    if (!session.data) return;
    const listener = (event) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== new URL(session.data.url).origin ||
        event.data?.type !== 'naru-extension-message'
      )
        return;
      if (
        event.data.level === 'navigate' &&
        ['/', '/images', '/volumes'].includes(event.data.message)
      ) {
        navigate(event.data.message);
        return;
      }
      if (event.data.level === 'link') {
        try {
          const url = new URL(event.data.message);
          if (['https:', 'http:'].includes(url.protocol))
            window.open(url.href, '_blank', 'noopener,noreferrer');
        } catch {}
        return;
      }
      notify(String(event.data.message));
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [session.data, navigate, notify]);
  if (id)
    return (
      <section className={cn(tw.page, 'h-full')}>
        <PageActions>
          <PageAction
            icon={ArrowLeft}
            label="설치된 확장으로 돌아가기"
            onClick={() => navigate('/extensions')}
          />
        </PageActions>

        {session.isLoading ? (
          <Skeleton />
        ) : session.error ? (
          <ErrorState error={session.error} />
        ) : (
          <iframe
            ref={frame}
            className="min-h-[520px] w-full flex-1 rounded-[12px] border border-line bg-white"
            title={session.data?.title || '확장 UI'}
            src={session.data?.url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
            referrerPolicy="no-referrer"
          />
        )}
      </section>
    );
  return (
    <section className={tw.page}>
      <PageActions>
        <PageAction
          label="확장 설치"
          icon={Plus}
          primary
          disabled={busy || !status?.ready}
          onClick={() =>
            form(
              '확장 설치',
              [
                {
                  key: 'image',
                  label: '확장 이미지',
                  required: true,
                  placeholder: 'registry.example.com/my-extension:1.0',
                },
                {
                  key: 'confirmation',
                  label: '신뢰하는 확장이면 TRUST 입력',
                  required: true,
                  pattern: 'TRUST',
                },
              ],
              (v) => job('installExtension', v),
              '확장은 Docker 엔진에 접근하고, 패키지가 선언한 Windows 실행파일 및 VM 서비스를 실행할 수 있습니다.',
            )
          }
        />
      </PageActions>
      {data.isLoading ? (
        <Skeleton />
      ) : data.error ? (
        <ErrorState error={data.error} />
      ) : data.data?.length ? (
        <div className={tw.cardList}>
          {data.data.map((ext) => (
            <article className={cn(tw.panel, tw.card)} key={ext.id}>
              <div className={tw.cardIcon}>
                <Puzzle size={24} />
              </div>
              <div>
                <h3>{ext.title}</h3>
                <p>
                  {ext.image} | {ext.engine === 'moby' ? 'Docker' : 'containerd'}
                </p>
              </div>
              <div className={tw.cardActions}>
                {ext.metadata.ui?.['dashboard-tab'] && (
                  <Button icon={ChevronRight} onClick={() => navigate('/extensions/' + ext.id)}>
                    열기
                  </Button>
                )}
                <IconButton
                  icon={Trash2}
                  label="확장 제거"
                  danger
                  disabled={busy}
                  onClick={() =>
                    confirm(
                      '확장 제거',
                      `${ext.title}의 UI, 호스트 실행파일과 VM 서비스를 제거합니다.`,
                      (v) =>
                        job('uninstallExtension', { id: ext.id, confirmation: v.confirmation }),
                      'REMOVE',
                    )
                  }
                />
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className={tw.panel}>
          <Empty title="설치된 확장이 없습니다">자주 사용하는 개발 도구를 추가해 보세요.</Empty>
        </div>
      )}
    </section>
  );
}

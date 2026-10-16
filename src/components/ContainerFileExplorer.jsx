import { t, useLocale } from '../i18n.js';
import React, { useState, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Folder,
  FileText,
  CornerLeftUp,
  Search,
  X,
  Trash2,
  Edit,
  Download,
  Upload,
  RefreshCw,
  Save,
} from 'lucide-react';
import { useActions, useData, Button, IconButton, CopyButton, Skeleton, ErrorState, bytes } from '../ui.jsx';
import { Modal } from './Modal/Modal.jsx';
import { api } from '../api.js';
import { cn, tw } from '../tw.js';

export function ContainerFileExplorer({ containerId }) {
  useLocale();
  const { notify, confirm } = useActions();
  const qc = useQueryClient();
  const [currentPath, setCurrentPath] = useState('/');
  const [search, setSearch] = useState('');
  const [editFile, setEditFile] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  const queryKey = ['container-files', containerId, currentPath];
  const files = useData(queryKey, `/containers/${containerId}/files?path=${encodeURIComponent(currentPath)}`, {
    enabled: !!containerId,
  });

  const pathParts = useMemo(() => {
    const parts = currentPath.split('/').filter(Boolean);
    const crumbs = [{ name: '/', path: '/' }];
    let acc = '';
    for (const part of parts) {
      acc += '/' + part;
      crumbs.push({ name: part, path: acc });
    }
    return crumbs;
  }, [currentPath]);

  const entries = useMemo(() => {
    const list = files.data?.entries || [];
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter((e) => e.name.toLowerCase().includes(q));
  }, [files.data?.entries, search]);

  const goUp = () => {
    if (currentPath === '/') return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    setCurrentPath('/' + parts.join('/'));
  };

  const openFile = async (entry) => {
    try {
      const res = await api(`/containers/${containerId}/files/content?path=${encodeURIComponent(entry.path)}`);
      setEditFile(entry);
      setEditContent(res.text ?? '');
    } catch (e) {
      notify(e);
    }
  };

  const saveFile = async () => {
    if (!editFile) return;
    setSaving(true);
    try {
      await api(`/containers/${containerId}/files/content`, {
        method: 'PUT',
        body: { path: editFile.path, text: editContent },
      });
      qc.invalidateQueries({ queryKey });
      notify(t('파일을 저장했습니다.'));
      setEditFile(null);
    } catch (e) {
      notify(e);
    } finally {
      setSaving(false);
    }
  };

  const deleteEntry = (entry) => {
    confirm(
      t('파일 삭제'),
      t('{0}을(를) 삭제합니다. 되돌릴 수 없습니다.', [entry.name]),
      async () => {
        try {
          await api(`/containers/${containerId}/files?path=${encodeURIComponent(entry.path)}`, {
            method: 'DELETE',
          });
          qc.invalidateQueries({ queryKey });
          notify(t('삭제했습니다.'));
        } catch (e) {
          notify(e);
        }
      },
    );
  };

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const text = reader.result;
      const targetPath = (currentPath === '/' ? '' : currentPath) + '/' + file.name;
      try {
        await api(`/containers/${containerId}/files/content`, {
          method: 'PUT',
          body: { path: targetPath, text: String(text) },
        });
        qc.invalidateQueries({ queryKey });
        notify(t('{0} 업로드 완료', [file.name]));
      } catch (err) {
        notify(err);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const downloadFile = (entry) => {
    api(`/containers/${containerId}/files/content?path=${encodeURIComponent(entry.path)}`)
      .then((res) => {
        const blob = new Blob([res.text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = entry.name;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch(notify);
  };

  return (
    <div className="flex flex-col">
      {/* 탐색기 상단 툴바 */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-line bg-[#fbfcf9] px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[12px]">
          <button
            type="button"
            disabled={currentPath === '/'}
            className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] border border-[#dce2d9] bg-white text-[#738177] hover:border-[#bdcdbb] hover:text-brand disabled:opacity-40"
            onClick={goUp}
            title={t('상위 디렉터리로 이동')}
          >
            <CornerLeftUp size={16} />
          </button>
          <div className="flex min-w-0 flex-wrap items-center gap-1 rounded-[6px] border border-[#e3e8df] bg-white px-2.5 py-1 text-ink">
            {pathParts.map((p, idx) => (
              <React.Fragment key={p.path}>
                {idx > 0 && <span className="text-[#9aa297]">/</span>}
                <button
                  type="button"
                  className={cn(
                    'hover:text-brand hover:underline',
                    idx === pathParts.length - 1 && 'font-semibold text-brand',
                  )}
                  onClick={() => setCurrentPath(p.path)}
                >
                  {p.name}
                </button>
              </React.Fragment>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex h-8.5 w-44 items-center gap-1.5 rounded-[6px] border border-[#e3e8df] bg-white px-2 text-[#8c978e]">
            <Search size={14} />
            <input
              className="h-full min-w-0 flex-1 bg-transparent text-[11px] text-ink outline-0 placeholder:text-[#9aa29b]"
              placeholder={t('파일 검색')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button type="button" onClick={() => setSearch('')}>
                <X size={13} />
              </button>
            )}
          </div>
          <label className="inline-flex h-8.5 cursor-pointer items-center gap-1.5 rounded-[6px] border border-[#dce2d9] bg-white px-2.5 text-[12px] font-semibold text-ink hover:border-[#bdcdbb] hover:bg-[#f2f6ed]">
            <Upload size={14} />
            <span>{t('파일 업로드')}</span>
            <input type="file" className="hidden" onChange={handleFileUpload} />
          </label>
          <Button
            compact
            icon={RefreshCw}
            disabled={files.isFetching}
            onClick={() => files.refetch()}
          >
            {t('새로고침')}
          </Button>
        </div>
      </div>

      {/* 파일 목록 */}
      <div className="max-h-[550px] min-h-[380px] overflow-y-auto p-2">
        {files.isLoading ? (
          <Skeleton />
        ) : files.error ? (
          <ErrorState error={files.error} retry={() => files.refetch()} />
        ) : entries.length === 0 ? (
          <div className="p-12 text-center text-[13px] text-[#8c978e]">
            {t('디렉터리가 비어 있거나 일치하는 파일이 없습니다.')}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {entries.map((entry) => (
              <div
                key={entry.path}
                className="flex items-center gap-3 rounded-[6px] px-3 py-2 text-[12px] transition-colors hover:bg-[#f2f6ed]"
              >
                {entry.isDir ? (
                  <Folder size={17} className="flex-none text-[#5b8a5d]" />
                ) : (
                  <FileText size={17} className="flex-none text-[#7a857c]" />
                )}
                <div
                  className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2"
                  onClick={() => (entry.isDir ? setCurrentPath(entry.path) : openFile(entry))}
                >
                  <span
                    className={cn(
                      'truncate font-mono',
                      entry.isDir ? 'font-semibold text-brand hover:underline' : 'text-ink',
                    )}
                  >
                    {entry.name}
                  </span>
                  <div className="flex items-center gap-4 text-[#8c978e]">
                    <span className="font-mono text-[11px]">{entry.mode}</span>
                    <span className="w-16 text-right font-mono text-[11px]">
                      {entry.isDir ? '-' : bytes(entry.size)}
                    </span>
                  </div>
                </div>

                <div className="flex flex-none items-center gap-1">
                  {!entry.isDir && (
                    <>
                      <IconButton
                        icon={Edit}
                        label={t('편집')}
                        onClick={() => openFile(entry)}
                      />
                      <IconButton
                        icon={Download}
                        label={t('다운로드')}
                        onClick={() => downloadFile(entry)}
                      />
                    </>
                  )}
                  <IconButton
                    icon={Trash2}
                    danger="row"
                    label={t('삭제')}
                    onClick={() => deleteEntry(entry)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 파일 편집 모달 */}
      {editFile && (
        <Modal
          isOpen
          title={editFile.name}
          size="lg"
          onClose={() => setEditFile(null)}
          footer={
            <>
              <CopyButton
                text={editContent}
                label={t('내용 복사')}
                className="mr-auto h-9 w-9 border border-[#dce2d9] bg-white"
              />
              <Button onClick={() => setEditFile(null)}>{t('닫기')}</Button>
              <Button primary icon={Save} disabled={saving} onClick={saveFile}>
                {saving ? t('저장 중…') : t('저장')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-2">
            <span className="font-mono text-[11px] text-[#8c978e]">{editFile.path}</span>
            <textarea
              className={cn(
                tw.terminal,
                'h-[420px] max-h-none overflow-auto font-mono text-[12px] leading-relaxed select-text',
              )}
              spellCheck={false}
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}

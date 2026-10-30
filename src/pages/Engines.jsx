import React, { useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, PlugZap } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { t, useLocale } from '../i18n.js';
import {
  useActions,
  useData,
  PageActions,
  PageAction,
  ResourceGrid,
  Button,
  IconButton,
} from '../ui.jsx';
import { Modal } from '../components/Modal/Modal.jsx';
import { tw } from '../tw.js';

const blank = { name: '', host: '', user: '', port: '', identityFile: '' };
export default function Engines() {
  useLocale();
  const data = useData('engines', '/engines');
  const { notify, confirm } = useActions();
  const qc = useQueryClient();
  const [edit, setEdit] = useState(null),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState('');
  const payload = (p) => ({
    name: p.name,
    host: p.host,
    user: p.user,
    port: p.port === '' || p.port == null ? null : Number(p.port),
    identityFile: p.identityFile,
  });
  const open = (p = blank) => {
    setEdit({ ...p });
    setResult('');
  };
  const test = async (p) => {
    setBusy(true);
    setResult('');
    try {
      const value = await api('/engines/test', { method: 'POST', body: payload(p) });
      setResult(`Docker ${value.version}: ${t('연결됨')}`);
      if (!edit) notify(`Docker ${value.version}: ${t('연결됨')}`);
    } catch (e) {
      setResult(e.message);
      if (!edit) notify(e);
    } finally {
      setBusy(false);
    }
  };
  const columns = useMemo(
    () => [
      { field: 'name', headerName: t('이름'), flex: 1, minWidth: 140 },
      { field: 'host', headerName: t('SSH 호스트 별칭 또는 주소'), flex: 1, minWidth: 180 },
      {
        field: 'user',
        headerName: t('사용자'),
        valueFormatter: ({ value }) => value || t('SSH 설정 사용'),
        width: 160,
      },
      {
        field: 'port',
        headerName: t('포트'),
        valueFormatter: ({ value }) => value || t('SSH 설정 사용'),
        width: 160,
      },
      {
        colId: 'actions',
        headerName: t('작업'),
        width: 136,
        sortable: false,
        cellRenderer: ({ data: p }) => (
          <div className="flex h-full items-center gap-1">
            <IconButton
              icon={PlugZap}
              label={t('연결 테스트')}
              disabled={busy}
              onClick={() => test(p)}
            />
            <IconButton
              icon={Pencil}
              label={t('연결 수정')}
              disabled={busy}
              onClick={() => open(p)}
            />
            <IconButton
              icon={Trash2}
              label={t('연결 삭제')}
              className="text-danger"
              disabled={busy}
              onClick={() =>
                confirm(
                  t('연결 삭제'),
                  t('프로필을 삭제합니다. 서버의 컨테이너와 데이터는 유지됩니다.'),
                  async () => {
                    try {
                      await api(`/engines/${p.id}`, { method: 'DELETE' });
                      window.location.assign('/engines');
                    } catch (e) {
                      notify(e);
                    }
                  },
                )
              }
            />
          </div>
        ),
      },
    ],
    [busy, edit, confirm, notify],
  );
  return (
    <section className={tw.page}>
      <PageActions>
        <PageAction primary icon={Plus} label={t('연결 추가')} onClick={() => open()} />
      </PageActions>
      <p className={tw.groupText}>
        {t(
          '기존 SSH 설정의 호스트 별칭, 사용자, 포트와 키를 재사용합니다. 호스트 키는 SSH에서 먼저 확인해 주세요.',
        )}
      </p>
      <p className={tw.groupText}>
        {t(
          '원격 마운트는 서버 경로를 사용합니다. Compose 상대 경로는 서버 작업 폴더 기준입니다. WSL 설정, 디스크, 스냅샷, Kubernetes와 확장은 로컬 전용입니다.',
        )}
      </p>
      <ResourceGrid query={{ ...data, data: data.data?.profiles }} columns={columns} />
      <Modal
        isOpen={!!edit}
        title={edit?.id ? t('연결 수정') : t('연결 추가')}
        onClose={() => !busy && setEdit(null)}
        footer={
          <>
            <Button
              disabled={busy || !edit?.host || !edit?.name}
              icon={PlugZap}
              onClick={() => test(edit)}
            >
              {t('연결 테스트')}
            </Button>
            <Button primary disabled={busy} type="submit" form="engine-profile">
              {t('저장')}
            </Button>
          </>
        }
      >
        {edit && (
          <form
            id="engine-profile"
            className="flex flex-col gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api(edit.id ? `/engines/${edit.id}` : '/engines', {
                  method: edit.id ? 'PUT' : 'POST',
                  body: payload(edit),
                });
                if (edit.id) window.location.assign('/engines');
                else {
                  setEdit(null);
                  qc.invalidateQueries({ queryKey: ['engines'] });
                }
              } catch (err) {
                notify(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {[
              ['name', '이름'],
              ['host', 'SSH 호스트 별칭 또는 주소'],
              ['user', '사용자'],
              ['port', '포트'],
              ['identityFile', '개인 키 파일 경로'],
            ].map(([key, label]) => (
              <label key={key} className="flex flex-col gap-2 text-sm">
                {t(label)}
                <input
                  className="rounded-lg border border-line bg-white px-3 py-2.5 text-ink"
                  required={key === 'name' || key === 'host'}
                  type={key === 'port' ? 'number' : 'text'}
                  min={key === 'port' ? 1 : undefined}
                  max={key === 'port' ? 65535 : undefined}
                  value={edit[key] ?? ''}
                  placeholder={
                    ['user', 'port', 'identityFile'].includes(key) ? t('SSH 설정 사용') : ''
                  }
                  onChange={(e) => setEdit({ ...edit, [key]: e.target.value })}
                />
              </label>
            ))}
            <p role="status" className="break-words text-sm">
              {result}
            </p>
          </form>
        )}
      </Modal>
    </section>
  );
}

import { t, useLocale } from '../i18n.js';
import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { RefreshCw } from 'lucide-react';
import { api } from '../api.js';
import { Button, Skeleton } from '../ui.jsx';
import SelectControl from './SelectControl/SelectControl.tsx';
import '@xterm/xterm/css/xterm.css';

export default function TerminalPanel({ containerId }) {
  useLocale();
  const hostRef = useRef(null);
  const [shell, setShell] = useState('/bin/sh');
  const [attempt, setAttempt] = useState(0);
  const [connection, setConnection] = useState({ state: 'connecting', message: '' });

  useEffect(() => {
    let disposed = false,
      socket,
      ready = false,
      failure = '',
      frame;
    let lastSize = '';
    const controller = new AbortController();
    setConnection({ state: 'connecting', message: '' });
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", Consolas, monospace',
      fontSize: 13,
      scrollback: 3000,
      screenReaderMode: true,
      theme: {
        background: '#142d26',
        foreground: '#d7e8cf',
        cursor: '#d4efae',
        selectionBackground: '#4f775d',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    terminal.textarea?.setAttribute('aria-label', t('컨테이너 터미널 입력'));
    terminal.textarea?.setAttribute('title', t('컨테이너 터미널 입력'));

    const resize = () => {
      if (disposed || !hostRef.current?.clientWidth) return;
      fit.fit();
      const size = `${terminal.cols}:${terminal.rows}`;
      if (ready && socket?.readyState === WebSocket.OPEN && size !== lastSize) {
        socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
        lastSize = size;
      }
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    });
    observer.observe(hostRef.current);
    const input = terminal.onData((data) => {
      if (ready && socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: 'input', data }));
    });
    const fail = (error) => {
      if (disposed) return;
      failure = error.message || String(error);
      ready = false;
      setConnection({ state: 'error', message: failure });
    };

    (async () => {
      try {
        const session = await api(`/containers/${encodeURIComponent(containerId)}/terminal`, {
          method: 'POST',
          body: { shell },
          signal: controller.signal,
        });
        if (disposed) return;
        socket = new WebSocket(session.url);
        socket.binaryType = 'arraybuffer';
        socket.onmessage = (event) => {
          if (disposed) return;
          if (typeof event.data !== 'string') {
            terminal.write(new Uint8Array(event.data));
            return;
          }
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'error') fail(new Error(message.error));
            if (message.type === 'ready') {
              ready = true;
              setConnection({ state: 'connected', message: '' });
              resize();
              terminal.focus();
            }
          } catch {
            fail(new Error(t('터미널 응답을 해석할 수 없습니다. 다시 연결해 주세요.')));
          }
        };
        socket.onerror = () => fail(new Error(t('터미널 연결을 확인한 후 다시 연결해 주세요.')));
        socket.onclose = () => {
          ready = false;
          if (!disposed && !failure)
            setConnection({ state: 'closed', message: t('터미널 세션이 종료되었습니다.') });
        };
      } catch (error) {
        fail(error);
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      observer.disconnect();
      cancelAnimationFrame(frame);
      input.dispose();
      if (socket) {
        socket.onmessage = socket.onerror = socket.onclose = null;
        socket.close();
      }
      terminal.dispose();
    };
  }, [containerId, shell, attempt]);

  return (
    <div className="min-w-0 p-5 max-tablet:p-4">
      <div className="mb-4 flex flex-wrap items-center gap-4 max-tablet:gap-2.5">
        <label className="flex flex-none items-center gap-2.5 text-[12px]">
          <span>{t('셸')}</span>
          <SelectControl
            aria-label={t('터미널 셸')}
            value={shell}
            onChange={(e) => setShell(e.target.value)}
          >
            {['/bin/sh', '/bin/bash', '/bin/ash'].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </SelectControl>
        </label>
        <span className="min-w-[100px] flex-1 text-[12px] wrap-anywhere text-muted" role="status">
          {connection.state === 'connected'
            ? t('연결됨')
            : connection.state === 'connecting'
              ? t('접속 중')
              : connection.message}
        </span>
        {['error', 'closed'].includes(connection.state) && (
          <Button icon={RefreshCw} onClick={() => setAttempt((value) => value + 1)}>
            {' '}
            {t('다시 연결')}{' '}
          </Button>
        )}
      </div>
      <div
        className="relative h-[420px] min-w-0 overflow-hidden rounded-[8px] bg-console p-3 max-tablet:h-[320px] max-tablet:p-2"
        aria-busy={connection.state === 'connecting'}
      >
        {/* xterm이 만드는 내부 요소는 클래스를 직접 붙일 수 없어 부모에서 지정한다. */}
        <div
          className="h-full w-full min-w-0 [&_.xterm]:h-full [&_.xterm-viewport]:overscroll-contain"
          ref={hostRef}
          data-terminal-host
        />
        {connection.state === 'connecting' && (
          <div className="absolute inset-0 rounded-[8px] border border-line bg-paper [&>div>div]:max-w-[460px]">
            <Skeleton />
          </div>
        )}
      </div>
    </div>
  );
}

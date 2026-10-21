import { t, useLocale } from '../i18n.js';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { RefreshCw, Play } from 'lucide-react';
import { api } from '../api.js';
import { Button, IconButton, Skeleton } from '../ui.jsx';
import SelectControl from './SelectControl/SelectControl.tsx';
import '@xterm/xterm/css/xterm.css';

const SNIPPETS = ['pwd', 'ls -la', 'env', 'df -h', 'ps aux', 'top'];

export default function TerminalPanel({ containerId }) {
  useLocale();
  const hostRef = useRef(null);
  const terminalRef = useRef(null);
  const socketRef = useRef(null);
  const [shell, setShell] = useState('/bin/sh');
  const [attempt, setAttempt] = useState(0);
  const [connection, setConnection] = useState({ state: 'connecting', message: '' });

  const runSnippet = useCallback((cmd) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      // 엔터(\r)를 붙여 전송하여 즉시 셸 명령으로 실행
      socketRef.current.send(JSON.stringify({ type: 'input', data: `${cmd}\r` }));
      terminalRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    let disposed = false,
      socket,
      ready = false,
      failure = '',
      resizeTimer = null;
    let lastCols = 0,
      lastRows = 0,
      lastWidth = 0,
      lastHeight = 0;

    const controller = new AbortController();
    setConnection({ state: 'connecting', message: '' });

    const terminal = new Terminal({
      cursorBlink: false,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
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
    terminalRef.current = terminal;

    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    terminal.textarea?.setAttribute('aria-label', t('컨테이너 터미널 입력'));

    const handleResize = () => {
      if (disposed || !hostRef.current?.clientWidth || !hostRef.current?.clientHeight) return;
      const currentWidth = hostRef.current.clientWidth;
      const currentHeight = hostRef.current.clientHeight;

      // 미세한 2px 이내 진동은 무시하여 리사이즈 렌더링 루프 및 커서 깜빡임 폭주를 방지
      if (Math.abs(currentWidth - lastWidth) < 2 && Math.abs(currentHeight - lastHeight) < 2) {
        return;
      }
      lastWidth = currentWidth;
      lastHeight = currentHeight;

      try {
        fit.fit();
      } catch {}

      if (ready && socket?.readyState === WebSocket.OPEN) {
        if (terminal.cols !== lastCols || terminal.rows !== lastRows) {
          socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
          lastCols = terminal.cols;
          lastRows = terminal.rows;
        }
      }
    };

    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(handleResize, 60);
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
        socketRef.current = socket;
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
              handleResize();
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
      if (resizeTimer) clearTimeout(resizeTimer);
      input.dispose();
      if (socket) {
        socket.onmessage = socket.onerror = socket.onclose = null;
        socket.close();
      }
      terminal.dispose();
      socketRef.current = null;
      terminalRef.current = null;
    };
  }, [containerId, shell, attempt]);

  return (
    <div className="flex min-h-0 flex-1 flex-col min-w-0 p-5 max-tablet:p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex flex-none items-center gap-2 text-[12px]">
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
          <span className="text-[12px] text-muted" role="status">
            {connection.state === 'connected'
              ? t('연결됨')
              : connection.state === 'connecting'
                ? t('접속 중')
                : connection.message}
          </span>
          {['error', 'closed'].includes(connection.state) && (
            <Button compact icon={RefreshCw} onClick={() => setAttempt((value) => value + 1)}>
              {t('다시 연결')}
            </Button>
          )}
        </div>

        {/* 터미널 스니펫 버튼 바 */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-semibold text-[#667768]">
            {t('스니펫')}:
          </span>
          {SNIPPETS.map((cmd) => (
            <button
              key={cmd}
              type="button"
              disabled={connection.state !== 'connected'}
              className="inline-flex items-center gap-1 rounded-[5px] border border-[#dce2d9] bg-white px-2 py-0.75 font-mono text-[11px] text-ink transition-colors hover:border-[#bdcdbb] hover:bg-[#f2f6ed] disabled:opacity-40"
              onClick={() => runSnippet(cmd)}
            >
              <span>{cmd}</span>
            </button>
          ))}
        </div>
      </div>

      <div
        className="relative flex min-h-[300px] flex-1 min-w-0 overflow-hidden rounded-[8px] bg-console p-3 max-tablet:p-2"
        aria-busy={connection.state === 'connecting'}
      >
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

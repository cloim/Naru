import { t, useLocale } from '../../i18n.js';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { isTopModal, popModal, pushModal } from './modalStack.js';
import { RESIZE_HANDLES, useModalGeometry } from './useModalGeometry.js';
import { cn } from '../../tw.js';

const PANEL_WIDTH = { sm: 'w-[420px]', md: 'w-[560px]', lg: 'w-[760px]', xl: 'w-[1040px]' };

// 리사이즈 핸들은 보이지 않지만 잡을 수 있을 만큼의 두께를 준다.
const HANDLE_CLASS = {
  n: 'top-[-3px] right-3 left-3 h-2 cursor-ns-resize',
  s: 'right-3 bottom-[-3px] left-3 h-2 cursor-ns-resize',
  e: 'top-3 right-[-3px] bottom-3 w-2 cursor-ew-resize',
  w: 'top-3 bottom-3 left-[-3px] w-2 cursor-ew-resize',
  ne: 'top-[-3px] right-[-3px] h-3.75 w-3.75 cursor-nesw-resize',
  nw: 'top-[-3px] left-[-3px] h-3.75 w-3.75 cursor-nwse-resize',
  se: 'right-[-3px] bottom-[-3px] h-3.75 w-3.75 cursor-nwse-resize',
  sw: 'bottom-[-3px] left-[-3px] h-3.75 w-3.75 cursor-nesw-resize',
};

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  draggable = true,
  resizable = false,
  storageKey,
  closeOnOverlayClick = true,
  closeOnEscape = true,
  initialFocusRef,
  minWidth = 320,
  minHeight = 200,
  className = '',
}) {
  useLocale();
  const panelRef = useRef(null);
  const previouslyFocusedRef = useRef(null);
  const overlayPointerDownRef = useRef(false);
  const modalId = useId();
  const [zIndex, setZIndex] = useState(null);

  const { panelStyle, headerProps, getResizeHandleProps, canDrag, canResize } = useModalGeometry({
    panelRef,
    isOpen,
    draggable,
    resizable,
    storageKey,
    minWidth,
    minHeight,
  });

  // 스택 등록과 해제. 등록 시점에 받은 z-index로 중첩 순서를 유지한다.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setZIndex(pushModal(modalId));
    return () => popModal(modalId);
  }, [isOpen, modalId]);

  // 열릴 때 첫 포커스를 옮기고, 닫힐 때 열기 직전 요소로 되돌린다. 되돌리지 않으면 모달을
  // 닫은 뒤 포커스가 body로 떨어져 키보드 사용자가 맥락을 잃는다.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    previouslyFocusedRef.current = document.activeElement;
    const timer = window.setTimeout(() => {
      const target =
        initialFocusRef?.current ??
        panelRef.current?.querySelector(FOCUSABLE_SELECTOR) ??
        panelRef.current;
      target?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      const previous = previouslyFocusedRef.current;
      if (previous instanceof HTMLElement && document.contains(previous)) {
        previous.focus();
      }
    };
  }, [isOpen, initialFocusRef]);

  // ESC와 Tab. ESC는 맨 위 모달만 반응해, 중첩 상태에서 한 번에 하나씩 닫히게 한다.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && closeOnEscape && isTopModal(modalId)) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === 'Tab' && isTopModal(modalId)) {
        trapFocus(event, panelRef.current);
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen, closeOnEscape, onClose, modalId]);

  // 오버레이 클릭 닫기. pointerdown과 click이 모두 오버레이에서 일어났을 때만 닫는다.
  // 본문에서 드래그를 시작해 오버레이에서 손을 뗀 경우(텍스트 선택, 헤더 드래그)에 모달이
  // 닫혀버리는 것을 막기 위한 조건이다.
  const onOverlayPointerDown = useCallback((event) => {
    overlayPointerDownRef.current = event.target === event.currentTarget;
  }, []);

  const onOverlayClick = useCallback(
    (event) => {
      const startedOnOverlay = overlayPointerDownRef.current;
      overlayPointerDownRef.current = false;
      if (closeOnOverlayClick && startedOnOverlay && event.target === event.currentTarget) {
        onClose();
      }
    },
    [closeOnOverlayClick, onClose],
  );

  if (!isOpen) {
    return null;
  }

  return createPortal(
    <div
      // 오버레이가 중앙 정렬을 맡고, 패널 transform은 이 위치에 이동량만 얹는다. z-index는 modalStack이 인라인으로 넣는다.
      className="fixed inset-0 z-1000 flex items-center justify-center bg-[rgba(24,22,20,0.42)] p-6 max-[768px]:p-3"
      style={{ zIndex: zIndex ?? undefined }}
      onPointerDown={onOverlayPointerDown}
      onClick={onOverlayClick}
    >
      <div
        ref={panelRef}
        // 좁은 화면에서는 저장된 위치와 크기가 남아 있어도 전체 폭으로 둔다. 훅의 인라인 style을 덮으려면 !가 필요하다.
        className={cn(
          'relative flex max-h-[calc(100vh-48px)] max-w-[calc(100vw-48px)] flex-none flex-col rounded-[12px] border border-[#dae2d4] bg-white font-sans text-ink shadow-[0_24px_60px_rgba(20,18,15,0.24)] outline-none max-[768px]:h-auto! max-[768px]:w-full! max-[768px]:max-w-full max-[768px]:transform-none! max-tablet:max-h-[calc(100dvh-24px)] max-tablet:max-w-[calc(100vw-24px)]',
          PANEL_WIDTH[size],
          className,
        )}
        style={panelStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${modalId}-title`}
        tabIndex={-1}
      >
        {/* 헤더가 드래그 손잡이라 제목 선택을 끈다. 본문 텍스트 선택은 그대로 둔다. */}
        <div
          className={cn(
            'flex flex-none items-center justify-between gap-3 border-b border-line px-6 py-5 select-none max-tablet:p-4.5',
            canDrag &&
              'cursor-grab touch-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#7580ff] active:cursor-grabbing',
          )}
          {...headerProps}
        >
          <h2
            className="min-w-0 overflow-hidden text-[15px] font-black text-ellipsis whitespace-nowrap text-[#202634]"
            id={`${modalId}-title`}
          >
            {title}
          </h2>
          <button
            type="button"
            className="flex h-7 w-7 flex-none items-center justify-center rounded-[6px] bg-transparent text-[#a29c94] hover:bg-[#f1efec] hover:text-[#4b5563]"
            onClick={onClose}
            aria-label={t('닫기')}
            data-modal-no-drag
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {/* 본문만 스크롤해서 헤더와 푸터의 손잡이와 작업 버튼을 항상 보이게 한다. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 text-[13px] text-[#202634] max-tablet:p-4.5">
          {children}
        </div>

        {footer ? (
          <div className="flex flex-none items-center justify-end gap-2.25 border-t border-line px-6 py-4 max-tablet:p-4.5">
            {footer}
          </div>
        ) : null}

        {canResize
          ? RESIZE_HANDLES.map((handle) => (
              <span
                key={handle.dir}
                className={cn('absolute touch-none', HANDLE_CLASS[handle.dir])}
                aria-hidden="true"
                {...getResizeHandleProps(handle)}
              />
            ))
          : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Tab 순환을 패널 안에 가둔다. 모달 뒤편의 요소로 포커스가 빠져나가면 화면 낭독기 사용자가
 * 보이지 않는 컨트롤을 만지게 된다.
 */
function trapFocus(event, panel) {
  if (!panel) {
    return;
  }
  // 숨겨진 요소를 걸러낸다. offsetParent는 position: fixed 요소에서 null이 되므로
  // getClientRects()로 실제 렌더 여부를 본다.
  const focusables = Array.from(panel.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getClientRects().length > 0,
  );
  if (focusables.length === 0) {
    event.preventDefault();
    panel.focus();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

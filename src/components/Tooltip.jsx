import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../tw.js';

/**
 * shadcn 스타일 툴팁 컴포넌트
 * - 브라우저 기본 title 툴팁을 대체하여 일관되고 세련된 시각적 피드백을 제공합니다.
 * - React Portal을 통해 렌더링되며, 뷰포트 경계를 벗어나지 않도록 좌표를 자동 조정합니다.
 */
export function Tooltip({ content, children, side = 'top', delay = 100 }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, transform: 'translate(-50%, 0)' });
  const triggerRef = useRef(null);
  const timerRef = useRef(null);

  const calculatePosition = useCallback(() => {
    if (!triggerRef.current || !content) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const gap = 6;
    let computedSide = side;

    // 상단바 등 화면 최상단 버튼은 bottom으로 자동 반전
    if (side === 'top' && rect.top < 44) {
      computedSide = 'bottom';
    } else if (side === 'bottom' && rect.bottom + 44 > window.innerHeight) {
      computedSide = 'top';
    }

    let top = 0;
    let transformY = '-100%';
    if (computedSide === 'top') {
      top = rect.top - gap;
      transformY = '-100%';
    } else if (computedSide === 'bottom') {
      top = rect.bottom + gap;
      transformY = '0%';
    } else {
      top = rect.top + rect.height / 2;
      transformY = '-50%';
    }

    // 화면 우측 및 좌측 경계 검출 및 transformX 조정
    let left = rect.left + rect.width / 2;
    let transformX = '-50%';
    const estimatedHalfWidth = Math.max(40, (String(content).length * 13 + 24) / 2);

    if (left + estimatedHalfWidth > window.innerWidth - 8) {
      // 우측 끝에 붙은 경우 우측 정렬
      left = Math.min(rect.right, window.innerWidth - 8);
      transformX = '-100%';
    } else if (left - estimatedHalfWidth < 8) {
      // 좌측 끝에 붙은 경우 좌측 정렬
      left = Math.max(rect.left, 8);
      transformX = '0%';
    }

    setPosition({
      top,
      left,
      transform: `translate(${transformX}, ${transformY})`,
    });
  }, [content, side]);

  const handleMouseEnter = () => {
    if (!content) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      calculatePosition();
      setOpen(true);
    }, delay);
  };

  const handleMouseLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setOpen(false);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!content) return children;

  return (
    <span
      ref={triggerRef}
      className="inline-flex flex-none items-center justify-center"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleMouseEnter}
      onBlur={handleMouseLeave}
    >
      {children}
      {open &&
        createPortal(
          <div
            role="tooltip"
            style={{
              position: 'fixed',
              top: `${position.top}px`,
              left: `${position.left}px`,
              transform: position.transform,
              zIndex: 99999,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
              width: 'max-content',
              maxWidth: 'calc(100vw - 20px)',
            }}
            className={cn(
              'rounded-[6px] border border-[#2b4c41] bg-[#142d26] px-2.5 py-1 font-sans text-[11px] leading-tight font-medium text-[#edf5e8] shadow-lg select-none whitespace-nowrap',
              'animate-in fade-in-0 zoom-in-95 duration-100',
            )}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}

export default Tooltip;

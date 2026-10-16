import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// 조건부 클래스를 합치고, 같은 속성의 Tailwind 클래스가 겹치면 뒤의 값만 남긴다.
export const cn = (...inputs) => twMerge(clsx(inputs));

// 여러 화면이 함께 쓰는 레이아웃 묶음. 한 화면에서만 쓰는 스타일은 해당 JSX에 직접 둔다.
export const tw = {
  page: 'm-auto flex min-h-full max-w-[1700px] flex-col gap-4 p-4',
  panel: 'min-w-0 overflow-hidden rounded-[13px] border border-line bg-paper',
  // 목록 화면의 패널은 남은 높이를 모두 쓰고, 그 안의 그리드가 영역을 채운다.
  gridPanel:
    'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[13px] border border-line bg-paper',
  actions: 'flex flex-wrap items-center gap-2.25',
  tabs: 'flex gap-5.5 overflow-x-auto border-b border-line px-6 max-tablet:px-4',
  tab: 'relative flex items-center gap-2 whitespace-nowrap px-0 py-4.5 text-[13px] font-semibold text-[#7a857c] [&>span]:rounded-[4px] [&>span]:bg-[#f0f2ed] [&>span]:px-1.5 [&>span]:py-0.5 [&>span]:text-[11px] [&>span]:text-[#808a82]',
  tabSelected:
    'text-[#245d48] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-[#35664d] [&>span]:bg-[#e9f3df] [&>span]:text-[#47763b]',
  field:
    'my-4 flex flex-col gap-2.25 first:mt-0 last:mb-0 [&_input]:w-full [&_input]:rounded-[7px] [&_input]:border [&_input]:border-[#dce4d6] [&_input]:bg-[#fdfefb] [&_input]:px-3 [&_input]:py-2.75 [&_input]:text-[13px] [&_input]:text-[#294035] [&_small]:text-[11px] [&_small]:leading-[1.6] [&_textarea]:min-h-[90px] [&_textarea]:w-full [&_textarea]:resize-y [&_textarea]:rounded-[7px] [&_textarea]:border [&_textarea]:border-[#dce4d6] [&_textarea]:bg-[#fdfefb] [&_textarea]:px-3 [&_textarea]:py-2.75 [&_textarea]:text-[12px] [&_textarea]:leading-[1.65] [&_textarea]:text-[#294035] [&>span]:text-[12px] [&>span]:font-semibold [&>span]:text-[#536454]',
  formRow: 'flex gap-5.5 max-tablet:flex-col max-tablet:gap-0 [&>label]:min-w-0 [&>label]:flex-1',
  checkbox: 'flex items-center gap-2.5 py-2.5 text-[13px] [&_input]:accent-brand',
  terminal:
    'm-0 max-h-[65vh] min-h-[270px] overflow-auto rounded-[8px] bg-console p-5.5 font-mono text-[12px] leading-[1.9] whitespace-pre-wrap wrap-anywhere text-[#d7e8cf] max-tablet:whitespace-pre max-tablet:wrap-normal',
  jsonView:
    'm-0 max-h-[65vh] overflow-auto bg-[#fafcf7] p-5.5 font-mono text-[12px] leading-[1.8] whitespace-pre-wrap wrap-anywhere',
  preserve: 'whitespace-pre-wrap wrap-anywhere',
  skeleton:
    'h-7.5 animate-shimmer rounded-[6px] bg-[linear-gradient(100deg,#e9eee4_20%,#f7f9f3_40%,#e9eee4_60%)] bg-[length:300%_100%]',
  nameCell:
    'flex h-full w-full min-w-0 items-center gap-3.25 text-left [&_small]:font-mono [&_small]:text-[10px] [&_small]:text-[#9aa297] [&_strong]:overflow-hidden [&_strong]:font-semibold [&_strong]:text-ellipsis [&>div]:flex [&>div]:min-w-0 [&>div]:flex-col [&>div]:gap-px [&>div]:leading-[1.6] [&>svg]:flex-none [&>svg]:text-[#64816f]',
  rowActions: 'flex h-full items-center justify-center gap-0.75',
  cardList: 'flex flex-col gap-3.75',
  card: 'flex items-center gap-6 p-6.25 max-tablet:flex-wrap max-tablet:gap-4 max-tablet:px-4 max-tablet:py-5 [&_p]:mt-2 [&_p]:text-[12px] [&_p]:text-muted',
  cardIcon: 'rounded-[12px] bg-[#f0f5e8] p-4.5 text-[#69885c] max-tablet:p-3',
  cardActions:
    'ml-auto flex flex-wrap items-center gap-2.25 max-tablet:ml-0 max-tablet:w-full max-tablet:justify-end',
  group: 'mb-5 px-7.5 py-6.5 max-tablet:px-5 max-tablet:py-5.5 [&_h3]:mb-4.5',
  groupText: 'text-[12px] text-[#74806e]',
};

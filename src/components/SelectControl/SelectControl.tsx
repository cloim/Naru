import { ChevronDown } from 'lucide-react';
import type { SelectHTMLAttributes } from 'react';
import { cn } from '../../tw.js';

export type SelectControlProps = SelectHTMLAttributes<HTMLSelectElement> & {
  wrapperClassName?: string;
};

export default function SelectControl({
  wrapperClassName = '',
  className = '',
  children,
  ...props
}: SelectControlProps) {
  return (
    <span className={cn('relative inline-flex items-center', wrapperClassName)}>
      <select
        className={cn(
          'cursor-pointer appearance-none rounded-[8px] border border-[#dce3d6] bg-[#f9fbf6] py-2 pr-9.5 pl-3 text-[13px] disabled:cursor-not-allowed disabled:opacity-60',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.75"
        size={14}
        strokeWidth={2}
        aria-hidden="true"
      />
    </span>
  );
}

import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type InputHTMLAttributes } from 'react';
import { CloseIcon, SearchIcon } from './icons';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-strong font-medium',
  secondary: 'bg-raised text-ink border border-line-strong hover:bg-overlay',
  ghost: 'text-ink-2 hover:text-ink hover:bg-raised',
  danger: 'bg-bad-soft text-bad hover:bg-bad/20',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: ReactNode;
}

export function Button({ variant = 'secondary', icon, className, children, type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-control px-3.5 text-[13px] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45',
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconButton({ label, className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx('inline-flex size-8 cursor-pointer items-center justify-center rounded-control text-ink-2 transition-colors hover:bg-raised hover:text-ink', className)}
      {...props}
    >
      {children}
    </button>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('rounded-card border border-line bg-surface', className)}>{children}</div>;
}

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad';

const BADGE_TONES: Record<Tone, string> = {
  neutral: 'bg-raised text-ink-2',
  accent: 'bg-accent-soft text-accent-strong',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
};

export function Badge({ tone = 'neutral', className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return <span className={cx('inline-flex h-5.5 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap', BADGE_TONES[tone], className)}>{children}</span>;
}

const DOT_TONES: Record<Tone, string> = {
  neutral: 'bg-ink-3',
  accent: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
};

export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden="true" className={cx('inline-block size-2 shrink-0 rounded-full', DOT_TONES[tone], className)} />;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx('relative h-5.5 w-9.5 shrink-0 cursor-pointer rounded-full transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-45', checked ? 'bg-accent' : 'bg-overlay')}
    >
      <span className={cx('absolute top-0.75 left-0.75 size-4 rounded-full transition-transform duration-200 ease-out', checked ? 'translate-x-4 bg-on-accent' : 'bg-ink-2')} />
    </button>
  );
}

export interface SegmentOption<T extends string | number> {
  value: T;
  label: string;
}

export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: readonly SegmentOption<T>[]; onChange: (next: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-9 items-center gap-0.5 rounded-control bg-surface p-0.75 ring-1 ring-line">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cx(
            'h-full cursor-pointer rounded-[6px] px-3 text-[13px] transition-colors duration-150',
            option.value === value ? 'bg-overlay text-ink' : 'text-ink-2 hover:text-ink',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx('h-9 cursor-pointer rounded-control border border-line-strong bg-raised px-2.5 text-[13px] text-ink transition-colors hover:bg-overlay', className)}
      {...props}
    >
      {children}
    </select>
  );
}

export function SearchField({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={cx('flex h-9 items-center gap-2 rounded-control bg-surface px-3 ring-1 ring-line transition-shadow focus-within:ring-2 focus-within:ring-accent', className)}>
      <SearchIcon size={16} className="shrink-0 text-ink-3" />
      <input type="search" className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3 [&::-webkit-search-cancel-button]:hidden" {...props} />
    </label>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon && <div className="flex size-12 items-center justify-center rounded-card bg-raised text-ink-2">{icon}</div>}
      <div>
        <h3 className="font-display text-[15px] font-semibold text-ink">{title}</h3>
        {children && <p className="mx-auto mt-1 max-w-sm text-[13px] text-ink-2">{children}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex items-end justify-between gap-6">
      <div className="min-w-0">
        <h1 className="font-display text-[26px] leading-tight font-semibold tracking-[-0.01em] text-ink">{title}</h1>
        {description && <p className="mt-1 text-[13.5px] text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-4">
      <h2 className="font-display text-[15px] font-semibold text-ink">{children}</h2>
      {aside}
    </div>
  );
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-2 text-[13px]">
      <dt className="shrink-0 text-ink-2">{label}</dt>
      <dd className="m-0 min-w-0 text-right tabular-nums text-ink select-text">{children}</dd>
    </div>
  );
}

/** A modal built on the native dialog element, which handles focus trapping and Esc. */
export function Dialog({ open, title, onClose, children, footer }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="m-auto w-full max-w-md rounded-hero border border-line-strong bg-raised p-0 text-ink open:animate-rise backdrop:bg-black/60"
    >
      <div className="flex items-center justify-between gap-4 px-5 pt-4">
        <h2 className="font-display text-base font-semibold">{title}</h2>
        <IconButton label="Close" onClick={onClose}>
          <CloseIcon size={16} />
        </IconButton>
      </div>
      <div className="px-5 pt-2 pb-5 text-[13.5px] text-ink-2">{children}</div>
      {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</div>}
    </dialog>
  );
}

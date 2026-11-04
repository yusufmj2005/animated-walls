import { CheckIcon, CloseIcon, IconButton, WarningIcon, cx } from '@animated-walls/design-system';
import { dismissNotice, noticesStore } from '../stores/appStores';
import { useStore } from '../stores/createStore';

const MAX_ISSUES_SHOWN = 6;

export function Notices() {
  const notices = useStore(noticesStore);
  return (
    <div className="pointer-events-none fixed right-5 bottom-5 z-50 flex w-96 flex-col gap-2" aria-live="polite">
      {notices.map((notice) => (
        <div key={notice.id} role="status" data-testid="notice" className="pointer-events-auto animate-rise rounded-card border border-line-strong bg-raised p-3.5 shadow-[0_16px_40px_rgb(0_0_0/0.45)]">
          <div className="flex items-start gap-2.5">
            <span className={cx('mt-0.5 shrink-0', notice.tone === 'ok' ? 'text-ok' : notice.tone === 'warn' ? 'text-warn' : 'text-bad')}>
              {notice.tone === 'ok' ? <CheckIcon size={16} /> : <WarningIcon size={16} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium text-ink">{notice.title}</div>
              {notice.detail && <div className="mt-0.5 text-[13px] text-ink-2 select-text">{notice.detail}</div>}
              {notice.issues && (
                <ul className="mt-1.5 flex flex-col gap-1 text-[13px] text-ink-2 select-text">
                  {notice.issues.slice(0, MAX_ISSUES_SHOWN).map((issue, index) => (
                    <li key={index}>{issue.message}</li>
                  ))}
                  {notice.issues.length > MAX_ISSUES_SHOWN && <li className="text-ink-3">…and {notice.issues.length - MAX_ISSUES_SHOWN} more</li>}
                </ul>
              )}
            </div>
            <IconButton label="Dismiss" className="-mt-1 -mr-1 size-7" onClick={() => dismissNotice(notice.id)}>
              <CloseIcon size={14} />
            </IconButton>
          </div>
        </div>
      ))}
    </div>
  );
}

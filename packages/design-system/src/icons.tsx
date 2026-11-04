import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function createIcon(paths: ReactNode) {
  return function Icon({ size = 18, ...props }: IconProps) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        {paths}
      </svg>
    );
  };
}

export const HomeIcon = createIcon(<><path d="M4 10.5 12 4l8 6.5" /><path d="M6 9v10h12V9" /><path d="M10 19v-5h4v5" /></>);
export const LibraryIcon = createIcon(<><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="m3.5 15.5 4.5-4 4 3.5 3-2.5 5.5 4.5" /><circle cx="15.5" cy="9" r="1.4" /></>);
export const StoreIcon = createIcon(<><path d="M4.5 9.5 6 4.5h12l1.5 5" /><path d="M4.5 9.5a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0" /><path d="M6 12v7.5h12V12" /></>);
export const DisplayIcon = createIcon(<><rect x="3" y="4.5" width="18" height="12" rx="2" /><path d="M9 20h6" /><path d="M12 16.5V20" /></>);
export const SettingsIcon = createIcon(<><path d="M4 7h9" /><path d="M17 7h3" /><circle cx="15" cy="7" r="2" /><path d="M4 17h3" /><path d="M11 17h9" /><circle cx="9" cy="17" r="2" /></>);
export const PlusIcon = createIcon(<><path d="M12 5v14" /><path d="M5 12h14" /></>);
export const SearchIcon = createIcon(<><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>);
export const CloseIcon = createIcon(<><path d="M6 6l12 12" /><path d="M18 6 6 18" /></>);
export const TrashIcon = createIcon(<><path d="M4.5 7h15" /><path d="M9.5 7V4.5h5V7" /><path d="M6.5 7 7.5 20h9l1-13" /></>);
export const VideoIcon = createIcon(<><rect x="3.5" y="6" width="12.5" height="12" rx="2.5" /><path d="m16 11 4.5-2.5v7L16 13" /></>);
export const ImageIcon = createIcon(<><rect x="3.5" y="5" width="17" height="14" rx="2.5" /><circle cx="9" cy="10" r="1.5" /><path d="m4 17 5-4 3.5 3 3-2.5 4.5 3.5" /></>);
export const CodeIcon = createIcon(<><path d="m8.5 8-4 4 4 4" /><path d="m15.5 8 4 4-4 4" /><path d="m13.5 5.5-3 13" /></>);
export const FolderIcon = createIcon(<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.5l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v7.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z" />);
export const RefreshIcon = createIcon(<><path d="M20 11.5a8 8 0 0 0-14.3-4.3L4 9" /><path d="M4 4.5V9h4.5" /><path d="M4 12.5a8 8 0 0 0 14.3 4.3L20 15" /><path d="M20 19.5V15h-4.5" /></>);
export const WarningIcon = createIcon(<><path d="M12 4.5 2.8 19.5h18.4Z" /><path d="M12 10v4.5" /><path d="M12 17.2v.1" /></>);
export const CheckIcon = createIcon(<path d="m5 12.5 4.5 4.5L19 7.5" />);
export const SparkIcon = createIcon(<path d="M12 3.5 13.8 10l6.7 2-6.7 2L12 20.5 10.2 14l-6.7-2 6.7-2Z" />);
export const PulseIcon = createIcon(<path d="M3 12h4l2.5-6 4 12 2.5-6h5" />);

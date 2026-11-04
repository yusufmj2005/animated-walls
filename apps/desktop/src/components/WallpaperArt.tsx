import { useEffect, useRef, useState } from 'react';
import { CodeIcon, ImageIcon, VideoIcon, cx } from '@animated-walls/design-system';
import type { WallpaperRecord } from '@animated-walls/shared-types';

const KIND_ICON = { video: VideoIcon, image: ImageIcon, web: CodeIcon };

/**
 * A wallpaper's still preview, playing video only while `playing` is set. Video decoding
 * here is the app's own UI cost, so a <video> is mounted only on demand and fully
 * unloaded afterwards.
 */
export function WallpaperArt({ wallpaper, playing = false, className }: { wallpaper: WallpaperRecord; playing?: boolean; className?: string }) {
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const Icon = KIND_ICON[wallpaper.type];
  // A video with no separate preview still shows its first frame.
  const showVideo = Boolean(wallpaper.videoUrl) && (playing || !wallpaper.previewUrl);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) {
      video.play().catch((error: unknown) => {
        // Playback interrupted by a quick mouse-out is normal. Anything else is not.
        if (!(error instanceof DOMException && error.name === 'AbortError')) setFailed(true);
      });
    } else {
      video.pause();
    }
  }, [playing]);

  return (
    <div className={cx('relative overflow-hidden bg-raised', className)}>
      {wallpaper.previewUrl && !failed && (
        <img src={wallpaper.previewUrl} alt="" draggable={false} onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover" />
      )}
      {showVideo && wallpaper.videoUrl && !failed && (
        <video ref={videoRef} src={wallpaper.videoUrl} muted loop playsInline preload="metadata" onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover" />
      )}
      {(failed || (!wallpaper.previewUrl && !wallpaper.videoUrl)) && (
        <div className="absolute inset-0 flex items-center justify-center text-ink-3">
          <Icon size={28} />
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { CodeIcon, ImageIcon, VideoIcon, cx } from '@animated-walls/design-system';
import type { WallpaperRecord } from '@animated-walls/shared-types';
import { usePageVisible } from '../hooks/usePageVisible';

const KIND_ICON = { video: VideoIcon, image: ImageIcon, web: CodeIcon };

/**
 * A wallpaper's still preview, playing video only while `playing` is set. Video decoding
 * here is the app's own UI cost, so a <video> is mounted only on demand and fully
 * unloaded afterwards.
 */
export function WallpaperArt({ wallpaper, playing = false, className }: { wallpaper: WallpaperRecord; playing?: boolean; className?: string }) {
  // Tracked apart: a video the PC cannot decode must not take its still image down with it.
  const [imageFailed, setImageFailed] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pageVisible = usePageVisible();
  const Icon = KIND_ICON[wallpaper.type];

  // A wallpaper app must not spend the GPU on its own previews when nobody can see them.
  const shouldPlay = playing && pageVisible;
  const hasImage = Boolean(wallpaper.previewUrl) && !imageFailed;
  const hasVideo = Boolean(wallpaper.videoUrl) && !videoFailed;
  // A video with no separate preview still shows its first frame.
  const showVideo = hasVideo && (shouldPlay || !hasImage);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (shouldPlay) {
      video.play().catch((error: unknown) => {
        // Playback interrupted by a quick mouse-out is normal. Anything else is not.
        if (!(error instanceof DOMException && error.name === 'AbortError')) setVideoFailed(true);
      });
    } else {
      video.pause();
    }
  }, [shouldPlay, showVideo]);

  return (
    <div className={cx('relative overflow-hidden bg-raised', className)}>
      {hasImage && <img src={wallpaper.previewUrl!} alt="" draggable={false} onError={() => setImageFailed(true)} className="absolute inset-0 size-full object-cover" />}
      {showVideo && <video ref={videoRef} src={wallpaper.videoUrl!} muted loop playsInline preload="metadata" onError={() => setVideoFailed(true)} className="absolute inset-0 size-full object-cover" />}
      {!hasImage && !hasVideo && (
        <div className="absolute inset-0 flex items-center justify-center text-ink-3">
          <Icon size={28} />
        </div>
      )}
    </div>
  );
}

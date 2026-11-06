import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { mimeForMediaKind } from '@animated-walls/wallpaper-format';
import type { Logger } from './logging/logger';
import { parseRange } from './mediaRange';
import { MEDIA_SCHEME, type MediaAsset, type WallpaperLibrary } from './wallpapers/wallpaperLibrary';

export const APP_SCHEME = 'app';
export const APP_HOST = 'ui';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' awall-media:",
  "media-src awall-media:",
  "font-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Must run before app `ready`. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    // `stream` is what lets <video> seek using range requests.
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  ]);
}

/**
 * Serves the UI from a custom scheme rather than file://. It gives the renderer a real
 * origin to validate IPC against, and a response header to carry the CSP.
 */
export function registerAppProtocol(rendererRoot: string, logger: Logger): void {
  const root = resolve(rendererRoot);

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });

    try {
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const path = resolve(join(root, relative));
      if (!path.startsWith(root + sep)) {
        logger.warn('app.protocol', 'protocol.traversal-blocked', { pathname: url.pathname });
        return new Response('Not found', { status: 404 });
      }

      const response = await net.fetch(pathToFileURL(path).toString());
      if (!response.ok) return new Response('Not found', { status: 404 });

      return new Response(response.body, {
        status: 200,
        headers: {
          'Content-Type': MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
          'Content-Security-Policy': CONTENT_SECURITY_POLICY,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      // A missing file and a malformed URL both end up here.
      logger.warn('app.protocol', 'protocol.failed', { pathname: url.pathname, error });
      return new Response('Not found', { status: 404 });
    }
  });
}

/**
 * Serves library media to the renderer. The URL carries only a wallpaper id and an
 * asset name; the path comes from the database. Web wallpaper code is never served.
 */
export function registerMediaProtocol(library: WallpaperLibrary, logger: Logger): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    const [id, asset] = url.pathname.replace(/^\/+/, '').split('/');
    if (url.host !== 'library' || !id || (asset !== 'preview' && asset !== 'entry')) {
      return new Response('Not found', { status: 404 });
    }

    try {
      const media = library.resolveMedia(id, asset as MediaAsset);
      if (!media) return new Response('Not found', { status: 404 });
      return await serveFile(media.path, mimeForMediaKind(media.kind), request.headers.get('range'));
    } catch (error) {
      logger.warn('app.protocol', 'media.failed', { id, asset, error });
      return new Response('Not found', { status: 404 });
    }
  });
}

async function serveFile(path: string, contentType: string, rangeHeader: string | null): Promise<Response> {
  const { size } = await stat(path);
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };

  const range = parseRange(rangeHeader, size);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1);
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;

  if (size === 0) return new Response(null, { status: 200, headers });

  const body = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream;
  return new Response(body, { status: range ? 206 : 200, headers });
}

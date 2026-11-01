import type { UseCaseInfo } from '@patchbay/core';
import type { MediaFile, UseCase } from './load.ts';

// The content hash in the query lets the files be cached for a day and still change with a deploy.
const url = (id: string, name: string, file: MediaFile) => `/showcase/${id}/${name}?v=${file.etag}`;

/** A use case as the landing page receives it from /api/use-cases. */
export function useCaseInfo(u: UseCase): UseCaseInfo {
  const id = u.meta.id;
  return {
    id,
    title: u.meta.title,
    tab: u.meta.tab,
    description: u.meta.description,
    prompt: u.prompt,
    dashboardId: u.dashboardId,
    video: u.video ? url(id, 'video.mp4', u.video) : null,
    videoSquare: u.videoSquare ? url(id, 'video-square.mp4', u.videoSquare) : null,
    poster: u.poster ? url(id, 'poster.jpg', u.poster) : null,
    attachment: u.attachment
      ? {
          name: u.attachment.name,
          url: url(id, u.attachment.name, u.attachment),
          rows: u.attachment.rows,
          bytes: u.attachment.size,
        }
      : null,
  };
}

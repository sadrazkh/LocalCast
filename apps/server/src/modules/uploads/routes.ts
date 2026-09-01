import express from 'express';
import type { Router } from 'express';
import { ApiException, ErrorCode, uploadCreateRequestSchema } from '@localcast/contract';
import type { ServerContext } from '../../kernel.js';
import { asyncRoute, deviceOf, parseWith, readInt } from '../shared/http.js';
import type { UploadService } from './sessions.js';

/**
 * `Upload-Offset` is borrowed from tus. Not the whole protocol — tus brings creation
 * extensions, metadata encoding and a HEAD-based discovery step this does not need — but the
 * header name is what every resumable-upload client library already speaks, and a query
 * parameter is accepted too because a service worker retrying a request finds it easier to
 * rewrite a URL than a header.
 */
export const OFFSET_HEADER = 'upload-offset';

export function createUploadRouter(ctx: ServerContext, uploads: UploadService): Router {
  const router = express.Router();

  router.post(
    '/uploads',
    express.json({ limit: '16kb' }),
    asyncRoute(async (req, res) => {
      const device = deviceOf(req);
      const body = parseWith(uploadCreateRequestSchema, req.body, 'upload request');
      const session = await uploads.create({
        deviceId: device.id,
        folderId: body.folderId,
        relativePath: body.relativePath,
        totalBytes: body.totalBytes,
        mtime: body.mtime,
      });
      res.status(201).json({ upload: session });
    }, ctx.log),
  );

  router.patch(
    '/uploads/:id',
    // No body parser here on purpose: the body is the file, and buffering a chunk into
    // memory before writing it defeats the point of chunking in the first place.
    asyncRoute(async (req, res) => {
      const device = deviceOf(req);
      const offset = readInt(req.headers[OFFSET_HEADER] ?? req.query['offset']);
      if (offset === null) {
        throw new ApiException(
          ErrorCode.BAD_REQUEST,
          `A byte offset is required in the \`${OFFSET_HEADER}\` header.`,
        );
      }

      try {
        const session = await uploads.append(
          String(req.params['id']),
          device.id,
          offset,
          req,
          readInt(req.headers['content-length']),
        );
        res.status(200).json({ upload: session });
      } catch (err) {
        // The phone went out of range mid-chunk. The offset is already persisted, so there
        // is nothing to report and nobody left to report it to; writing to a dead socket
        // would only turn a normal event into an exception in the log.
        if (!res.writable || req.destroyed) return;
        throw err;
      }
    }, ctx.log),
  );

  router.get(
    '/uploads/:id',
    asyncRoute(async (req, res) => {
      const device = deviceOf(req);
      res.json({ upload: uploads.get(String(req.params['id']), device.id) });
    }, ctx.log),
  );

  router.delete(
    '/uploads/:id',
    asyncRoute(async (req, res) => {
      const device = deviceOf(req);
      res.json({ upload: await uploads.abort(String(req.params['id']), device.id) });
    }, ctx.log),
  );

  return router;
}

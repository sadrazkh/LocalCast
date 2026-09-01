import express from 'express';
import type { Router } from 'express';
import { API_PREFIX } from '@localcast/contract';
import type { ApiError } from '@localcast/contract';
import type { ServerContext, ServerModule } from '../../kernel.js';
import { asyncRoute, deviceOf } from '../shared/http.js';

/**
 * What answers the print routes while `PRINTING_ENABLED` is false.
 *
 * The alternative — registering nothing — was rejected. The PWA, the desktop client and the
 * WebDAV-adjacent tooling all know these paths; with nothing mounted they would meet the core's
 * `notFoundHandler` and get a bare `not_found`, which is indistinguishable from a routing bug
 * and would send whoever hits it looking for a defect that is not there. So the surface stays,
 * and says exactly what is true: the feature is switched off in this build.
 *
 * It is deliberately inert. No `PrintQueue`, no spooler, no PowerShell, no writes to
 * `print_jobs` — a disabled feature must not keep a background job running or touch the
 * database on boot.
 */

/**
 * The wire code for "this feature is switched off".
 *
 * Not a member of the contract's `ErrorCode`, because printing is coming back and adding a code
 * for a temporary state to the shared contract would outlive the state. It is safe: the
 * contract's `apiErrorSchema` types `code` as a plain string, and `client-core`'s
 * `errorFromResponse` explicitly falls back to the HTTP status for a code it does not
 * recognise, so an older or newer client still gets a typed error and the server's own message.
 */
export const PRINTING_DISABLED_CODE = 'printing_disabled';

/**
 * 503, not 404 and not 500.
 *
 * 404 says the route does not exist, which is a lie that costs somebody an afternoon. 500 says
 * LocalCast broke. 503 is the honest one: the server is fine, this capability is not being
 * served right now.
 */
export const PRINTING_DISABLED_STATUS = 503;

/** Typed against the contract envelope, so a change to the error shape fails to compile here. */
export function printingDisabledBody(): ApiError {
  return {
    error: {
      code: PRINTING_DISABLED_CODE,
      message:
        'Printing is switched off in this build of LocalCast. Everything else — browsing, ' +
        'streaming, WebDAV and uploads — is unaffected.',
    },
  };
}

/**
 * The paths the real print router claims, so the two surfaces cannot drift apart silently:
 * anything `modules/print/routes.ts` mounts is matched here too.
 */
const PRINT_PATHS = ['/printers', '/print', '/print/*'];

export function createPrintDisabledRouter(ctx: ServerContext): Router {
  const router = express.Router();

  router.all(
    PRINT_PATHS,
    asyncRoute(async (req, res) => {
      // Authentication is still checked first, exactly as every other route under the API
      // prefix does. An unauthenticated caller learns nothing about which features this
      // machine has turned on, and the 401 stays where it was.
      deviceOf(req);
      res.status(PRINTING_DISABLED_STATUS).json(printingDisabledBody());
    }, ctx.log),
  );

  return router;
}

/**
 * Stands in for `createPrintModule()` when printing is off.
 *
 * Named `print-disabled` rather than `print` on purpose: the module list is what the boot log
 * and the registry test read, and a module claiming to be `print` while printing nothing would
 * make the log say the opposite of the truth.
 */
export function createPrintDisabledModule(): ServerModule {
  return {
    name: 'print-disabled',

    register(app, ctx) {
      app.use(API_PREFIX, createPrintDisabledRouter(ctx));
      ctx.log.info('printing is switched off in this build; print routes answer 503', {
        code: PRINTING_DISABLED_CODE,
      });
    },
  };
}

import { Router } from 'express';
import {
  ApiException,
  ErrorCode,
  dnsProviderSchema,
  networkConfigSchema,
  type NetworkConfig,
} from '@localcast/contract';
import type { ServerContext } from '../../kernel.js';
import { wrap } from '../errors.js';

/**
 * The single `network_config` row, read and written by the panel.
 *
 * `auth_key_enc` and `dns_token_enc` hold DPAPI ciphertext produced by the Electron main
 * process. The server has no key for them, never decrypts them, and never logs them — they
 * are opaque strings it stores on the operator's behalf. It also never hands them back: the
 * response reports only whether a secret is on file, because a value that is never returned
 * cannot be leaked by a later mistake in a caller.
 */

interface NetworkConfigRow {
  mode: 'default' | 'custom';
  control_url: string | null;
  auth_key_enc: string | null;
  expose: 'tailnet' | 'funnel';
  cert_strategy: 'control-plane' | 'external-proxy' | 'dns01';
  cert_domain: string | null;
  dns_provider: string | null;
  dns_token_enc: string | null;
  hostname: string;
  updated_at: number;
}

/** The contract's config minus the secrets, plus the presence flags the panel renders. */
export type StoredNetworkConfig = Omit<NetworkConfig, 'authKey' | 'dnsApiToken'> & {
  hasAuthKey: boolean;
  hasDnsApiToken: boolean;
};

export function createNetworkConfigRouter(ctx: ServerContext): Router {
  const router = Router();
  const { db } = ctx;

  router.get(
    '/network-config',
    wrap((_req, res) => {
      res.json(view(read(ctx)));
    }),
  );

  router.post(
    '/network-config',
    wrap((req, res) => {
      const stored = read(ctx);
      // Validation runs on the *effective* configuration — what is being submitted merged
      // with what is already on file — so a rule like "dns01 needs an API token" is satisfied
      // by the token the user entered last week instead of forcing them to retype it just to
      // change the domain next to it.
      const config = networkConfigSchema.parse(withStoredSecrets(req.body, stored));

      db.prepare(
        `INSERT INTO network_config
           (id, mode, control_url, auth_key_enc, expose, cert_strategy, cert_domain,
            dns_provider, dns_token_enc, hostname, updated_at)
         VALUES (1, @mode, @controlUrl, @authKey, @expose, @certStrategy, @certDomain,
                 @dnsProvider, @dnsApiToken, @hostname, @updatedAt)
         ON CONFLICT (id) DO UPDATE SET
           mode          = excluded.mode,
           control_url   = excluded.control_url,
           auth_key_enc  = excluded.auth_key_enc,
           expose        = excluded.expose,
           cert_strategy = excluded.cert_strategy,
           cert_domain   = excluded.cert_domain,
           dns_provider  = excluded.dns_provider,
           dns_token_enc = excluded.dns_token_enc,
           hostname      = excluded.hostname,
           updated_at    = excluded.updated_at`,
      ).run({
        mode: config.mode,
        controlUrl: config.controlUrl ?? null,
        authKey: blank(config.authKey),
        expose: config.expose,
        certStrategy: config.certStrategy,
        certDomain: config.certDomain ?? null,
        dnsProvider: config.dnsProvider ?? null,
        dnsApiToken: blank(config.dnsApiToken),
        hostname: config.hostname,
        updatedAt: Date.now(),
      });

      // Deliberately only the shape of the decision: an activity entry is shown in the panel
      // and kept on disk, so nothing secret may ever be written into one.
      ctx.activity.record('network.updated', null, {
        mode: config.mode,
        expose: config.expose,
        certStrategy: config.certStrategy,
      });

      res.json(view(read(ctx)));
    }),
  );

  return router;
}

function read(ctx: ServerContext): NetworkConfigRow {
  const row = ctx.db.prepare('SELECT * FROM network_config WHERE id = 1').get() as
    | NetworkConfigRow
    | undefined;
  if (!row) {
    // `openDatabase` seeds this row, so its absence means the database was edited by hand.
    // Saying so beats answering with an invented default the edge would then try to run.
    throw new ApiException(ErrorCode.INTERNAL, 'The network configuration row is missing');
  }
  return row;
}

/**
 * The panel shows a stored secret as a masked placeholder and sends the field only when the
 * user types a new one, so an omitted secret means "keep what is stored" — never "clear it".
 * Getting this wrong would unpair a working Headscale the moment someone changed the
 * hostname. An explicit empty string is the one way to clear a secret.
 *
 * The merge happens on the raw body and the result still goes through `networkConfigSchema`;
 * nothing here decides whether a field is acceptable.
 */
function withStoredSecrets(body: unknown, row: NetworkConfigRow): Record<string, unknown> {
  const incoming: Record<string, unknown> =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>) }
      : {};
  if (incoming['authKey'] === undefined && row.auth_key_enc) {
    incoming['authKey'] = row.auth_key_enc;
  }
  if (incoming['dnsApiToken'] === undefined && row.dns_token_enc) {
    incoming['dnsApiToken'] = row.dns_token_enc;
  }
  return incoming;
}

/**
 * Optional fields are omitted rather than sent as `null`, so the object the panel receives
 * can be handed straight back to `POST` and to `networkConfigSchema`, which accepts an
 * absent optional field but not a null one.
 */
function view(row: NetworkConfigRow): StoredNetworkConfig {
  const dnsProvider = dnsProviderSchema.safeParse(row.dns_provider);
  return {
    mode: row.mode,
    ...(row.control_url ? { controlUrl: row.control_url } : {}),
    expose: row.expose,
    certStrategy: row.cert_strategy,
    ...(row.cert_domain ? { certDomain: row.cert_domain } : {}),
    ...(dnsProvider.success ? { dnsProvider: dnsProvider.data } : {}),
    hostname: row.hostname,
    hasAuthKey: Boolean(row.auth_key_enc),
    hasDnsApiToken: Boolean(row.dns_token_enc),
  };
}

function blank(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

import { z } from 'zod';

/**
 * The contract between Electron (TypeScript) and `netedge` (Go).
 *
 * This file is the only place the two languages meet, so it is deliberately small and
 * explicit. `native/netedge/internal/protocol/protocol.go` mirrors these shapes and a test
 * on each side asserts the JSON round-trips.
 */

/**
 * Which control plane the node talks to.
 * - `default` — Tailscale's own coordination server; certificates come free from its ACME
 *   delegation and nothing is asked of the user.
 * - `custom`  — a self-hosted Headscale. Headscale does not implement `/machine/set-dns`,
 *   so `tailscale cert` cannot work there and a certificate strategy must be chosen.
 */
export const networkModeSchema = z.enum(['default', 'custom']);
export type NetworkMode = z.infer<typeof networkModeSchema>;

/** Tailnet-only, or additionally published to the public internet through Funnel. */
export const exposeSchema = z.enum(['tailnet', 'funnel']);
export type Expose = z.infer<typeof exposeSchema>;

/**
 * - `control-plane` — `LocalClient.CertPair`. Only valid in `default` mode.
 * - `external-proxy` — the user terminates TLS in front of us (Caddy/Traefik/nginx); we
 *   serve plain HTTP on the tailnet address and trust the proxy.
 * - `dns01` — we run our own ACME DNS-01 client against a domain the user owns.
 */
export const certStrategySchema = z.enum(['control-plane', 'external-proxy', 'dns01']);
export type CertStrategy = z.infer<typeof certStrategySchema>;

export const dnsProviderSchema = z.enum(['cloudflare', 'digitalocean', 'route53', 'gandi']);

export const networkConfigSchema = z
  .object({
    mode: networkModeSchema,
    /** Required when mode is `custom`; ignored otherwise. */
    controlUrl: z.string().url().optional(),
    /** Pre-authentication key for Headscale. Stored encrypted; never logged. */
    authKey: z.string().optional(),
    expose: exposeSchema.default('tailnet'),
    certStrategy: certStrategySchema,
    /** Required for `dns01` and `external-proxy`. */
    certDomain: z.string().optional(),
    dnsProvider: dnsProviderSchema.optional(),
    dnsApiToken: z.string().optional(),
    hostname: z.string().min(1).default('localcast'),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.mode === 'custom' && !cfg.controlUrl) {
      ctx.addIssue({ code: 'custom', path: ['controlUrl'], message: 'controlUrl is required in custom mode' });
    }
    if (cfg.mode === 'custom' && cfg.certStrategy === 'control-plane') {
      ctx.addIssue({
        code: 'custom',
        path: ['certStrategy'],
        message:
          'Headscale cannot issue certificates through the control plane; choose external-proxy or dns01',
      });
    }
    if (cfg.mode === 'custom' && cfg.expose === 'funnel') {
      ctx.addIssue({
        code: 'custom',
        path: ['expose'],
        message: 'Funnel is a Tailscale service and is not available on a self-hosted control server',
      });
    }
    if (cfg.certStrategy === 'dns01' && (!cfg.certDomain || !cfg.dnsProvider || !cfg.dnsApiToken)) {
      ctx.addIssue({
        code: 'custom',
        path: ['certDomain'],
        message: 'dns01 needs a domain, a provider and an API token',
      });
    }
    if (cfg.certStrategy === 'external-proxy' && !cfg.certDomain) {
      ctx.addIssue({ code: 'custom', path: ['certDomain'], message: 'external-proxy needs the public domain' });
    }
  });
export type NetworkConfig = z.infer<typeof networkConfigSchema>;

/** What the tray dot and the settings page render. Nothing here leaks transport detail. */
export const edgeStateSchema = z.enum([
  'stopped',
  'starting',
  'login-required',
  'connecting',
  'obtaining-certificate',
  'connected',
  'error',
]);
export type EdgeState = z.infer<typeof edgeStateSchema>;

export const edgeStatusSchema = z.object({
  state: edgeStateSchema,
  /** MagicDNS FQDN once known, e.g. `localcast.tail1234.ts.net`. */
  host: z.string().nullable(),
  /** Public Funnel URL when `expose` is `funnel`. */
  funnelUrl: z.string().nullable(),
  /** Present only while `state` is `login-required`. Electron opens it in the browser. */
  loginUrl: z.string().nullable(),
  /** Stable code from the ErrorCode table when `state` is `error`. */
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  certExpiresAt: z.number().int().nullable(),
  peers: z.number().int(),
  updatedAt: z.number().int(),
});
export type EdgeStatus = z.infer<typeof edgeStatusSchema>;

/**
 * Result of a dry run against a candidate config. The settings page calls this before it is
 * allowed to save, so a configuration that cannot possibly work is rejected while the user
 * is still looking at the form — rather than becoming a permanent "connecting…" spinner.
 */
export const edgeTestResultSchema = z.object({
  ok: z.boolean(),
  controlReachable: z.boolean(),
  /** Whether the chosen certificate strategy can actually produce a certificate. */
  certificateViable: z.boolean(),
  /** Human-readable, already localised by the caller's locale header. */
  messages: z.array(z.object({ level: z.enum(['info', 'warn', 'error']), text: z.string() })),
  /** Populated when the control server offers an interactive login instead of a key. */
  loginUrl: z.string().nullable(),
});
export type EdgeTestResult = z.infer<typeof edgeTestResultSchema>;

/** Newline-delimited JSON that `netedge` writes to stdout, so Electron can log and react. */
export const edgeStdoutEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), controlPort: z.number().int() }),
  z.object({ type: z.literal('status'), status: edgeStatusSchema }),
  z.object({ type: z.literal('log'), level: z.enum(['debug', 'info', 'warn', 'error']), message: z.string() }),
]);
export type EdgeStdoutEvent = z.infer<typeof edgeStdoutEventSchema>;

/** Routes on `netedge`'s loopback control API. */
export const EDGE_ROUTES = {
  status: '/edge/status',
  statusStream: '/edge/status/stream',
  config: '/edge/config',
  test: '/edge/test',
  login: '/edge/login',
  logout: '/edge/logout',
  restart: '/edge/restart',
} as const;

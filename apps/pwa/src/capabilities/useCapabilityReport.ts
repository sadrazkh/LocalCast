import { useEffect, useRef } from 'react';
import { useClientContext } from '../client/ClientProvider.js';
import { useCapabilities } from './store.js';
import { postCapabilityReport, toReportBody } from './report.js';

/**
 * Sends this device's capability report once the answer is known, and again only if it changes.
 *
 * Runs from the app shell rather than from a screen, because the fact worth reporting — that
 * the browser refused to register a service worker — is true whether or not anybody visits the
 * settings screen. A diagnostic you have to go looking for is one nobody has when it matters.
 *
 * Nothing waits on it. A failed post is dropped; the next launch reports again.
 */
export function useCapabilityReport(): void {
  const { client, session, baseUrl } = useClientContext();
  const { capabilities } = useCapabilities();
  /** The last payload the server accepted, so an unchanged answer is not re-sent per render. */
  const sent = useRef<string | null>(null);

  useEffect(() => {
    if (session === null) return;
    const body = toReportBody(capabilities);
    // Still waiting for registration to settle. Reporting "no offline library" about a device
    // that is 300 ms away from having one would be worse than reporting nothing.
    if (body === null) return;

    const payload = JSON.stringify(body);
    if (sent.current === payload) return;

    const controller = new AbortController();
    void (async () => {
      // A stale access token would come back 401 and the report would be lost for the session;
      // `ensureFresh` is the same rotation every other request already goes through.
      const fresh = await client.session.ensureFresh().catch(() => null);
      const accessToken = fresh?.accessToken ?? session.accessToken;
      const accepted = await postCapabilityReport({
        baseUrl,
        accessToken,
        body,
        signal: controller.signal,
      });
      if (accepted) sent.current = payload;
    })();

    return () => controller.abort();
  }, [client, session, baseUrl, capabilities]);
}

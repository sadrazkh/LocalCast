import { useState } from 'react';
import {
  AlertIcon,
  Badge,
  Button,
  CheckIcon,
  ExternalIcon,
  InfoIcon,
  ProgressBar,
  useDomId,
  useT,
} from '@localcast/ui-kit';
import type { BadgeTone } from '@localcast/ui-kit';
import type { PrerequisiteStatus, Remedy } from '../../shared/preflight.js';
import { openInBrowser } from './api.js';
import { usePreflightText } from './copy.js';
import type { InstallAttempt, PreflightController } from './usePreflight.js';
import styles from './PrerequisiteCard.module.css';

/**
 * One prerequisite: what it is in plain words, how it stands, and the buttons that fix it.
 *
 * Three rules are load-bearing here and none of them are cosmetic.
 *
 *  1. **`blocking` and `degrading` are told apart in words, not only in colour.** A blocking
 *     item says there is no way forward; a degrading one names the single feature it costs
 *     and offers to carry on without it. The "continue" control does not exist on a blocking
 *     card — not disabled, absent.
 *  2. **Nothing runs unseen.** A `command` remedy reveals the exact command on the first
 *     press and only runs on the second.
 *  3. **The searched paths are the fix**, so they are always available for a missing item —
 *     folded away, because they are not what the user reads first.
 */

export interface PrerequisiteCardProps {
  item: PrerequisiteStatus;
  attempt: InstallAttempt | null;
  busy: boolean;
  controller: PreflightController;
  /**
   * Present only for a `degrading` item that the wizard is willing to move past. Absent —
   * not disabled — on everything else.
   */
  onContinueWithout?: () => void;
}

export function PrerequisiteCard({
  item,
  attempt,
  busy,
  controller,
  onContinueWithout,
}: PrerequisiteCardProps) {
  const t = useT();
  const { c, nameOf, featureOf, stateOf, labelOf } = usePreflightText();
  const headingId = useDomId('prereq');
  // Which command the user has asked to see. Nothing has run at this point.
  const [revealed, setRevealed] = useState<Remedy | null>(null);

  const blocking = item.severity === 'blocking';
  const satisfied = item.state === 'ok';
  const installing = item.state === 'installing' || busy;
  const showPaths = !satisfied && item.searchedPaths.length > 0;
  const showDisclosure = !satisfied && (showPaths || item.detail !== '');

  return (
    <li className={styles.card} aria-labelledby={headingId} data-state={item.state}>
      <div className={styles.head}>
        <span className={satisfied ? styles.iconOk : blocking ? styles.iconStop : styles.iconWarn}>
          {satisfied ? <CheckIcon size={18} /> : blocking ? <AlertIcon size={18} /> : <InfoIcon size={18} />}
        </span>
        <div className={styles.headText}>
          <h2 className={styles.name} id={headingId}>
            {nameOf(item.id)}
          </h2>
          {!satisfied ? (
            <p className={styles.severity}>
              {blocking
                ? c('preflight.blockingBody')
                : c('preflight.degradingBody', { feature: featureOf(item.id) })}
            </p>
          ) : null}
        </div>
        <Badge tone={stateTone(item)} dot>
          {stateOf(item.state)}
        </Badge>
      </div>

      {installing ? (
        <ProgressBar
          value={typeof item.progress === 'number' ? item.progress : null}
          label={c('preflight.installing')}
          tone="accent"
          size="sm"
        />
      ) : null}

      {showDisclosure ? (
        <details className={styles.disclosure}>
          <summary className={styles.summary}>
            {showPaths ? c('preflight.paths') : c('preflight.details')}
          </summary>
          {showPaths ? (
            <>
              <ul className={styles.paths}>
                {item.searchedPaths.map((path) => (
                  // A Windows path is ASCII and full of backslashes; inside an RTL paragraph
                  // it reorders into nonsense unless it is isolated.
                  <li key={path} className={styles.mono} dir="ltr">
                    {path}
                  </li>
                ))}
              </ul>
              <p className={styles.hint}>{c('preflight.pathsHint')}</p>
            </>
          ) : null}
          {/*
            `detail` is written in English by the main process on purpose: it carries paths,
            ABI numbers and toolchain versions, and is meant to be pasted into a bug report
            verbatim. That makes it diagnostic text, not copy — so it lives here, under the
            fold, and never becomes the sentence the user reads first.
          */}
          {item.detail ? (
            <p className={styles.hint} lang="en" dir="ltr">
              {item.detail}
            </p>
          ) : null}
        </details>
      ) : null}

      {attempt ? <AttemptResult item={item} attempt={attempt} controller={controller} /> : null}

      {revealed?.command ? (
        <div className={styles.command} role="group">
          <p className={styles.commandTitle}>{c('preflight.commandTitle')}</p>
          <code className={styles.mono} dir="ltr">
            {revealed.command}
          </code>
          <div className={styles.commandActions}>
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              onClick={() => {
                const remedy = revealed;
                setRevealed(null);
                void controller.runCommand(item.id, remedy);
              }}
            >
              {c('preflight.commandRun')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRevealed(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {!satisfied && !revealed ? (
        <div className={styles.actions}>
          {item.remedies.map((remedy, index) => (
            <RemedyControl
              key={`${remedy.kind}-${remedy.labelKey}`}
              remedy={remedy}
              primary={index === 0}
              busy={busy}
              label={labelOf(remedy)}
              onDownload={() => void controller.install(item.id, remedy)}
              onCommand={() => setRevealed(remedy)}
              onDoc={() => {
                if (remedy.docPath) void controller.openDoc(remedy.docPath);
              }}
            />
          ))}

          {/* Only ever on a degrading card. A blocking one has no such offer to make. */}
          {onContinueWithout && !blocking ? (
            <Button variant="ghost" size="sm" onClick={onContinueWithout}>
              {c('preflight.continueWithout')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function stateTone(item: PrerequisiteStatus): BadgeTone {
  if (item.state === 'ok') return 'success';
  if (item.state === 'checking' || item.state === 'installing') return 'accent';
  return item.severity === 'blocking' ? 'danger' : 'warning';
}

/**
 * A remedy button, plus — for a download — the publisher's page beside it. The source is on
 * screen before anything is fetched; it is not something the user discovers afterwards in a
 * log.
 */
function RemedyControl({
  remedy,
  primary,
  busy,
  label,
  onDownload,
  onCommand,
  onDoc,
}: {
  remedy: Remedy;
  primary: boolean;
  busy: boolean;
  label: string;
  onDownload: () => void;
  onCommand: () => void;
  onDoc: () => void;
}) {
  const { c } = usePreflightText();
  const onClick = remedy.kind === 'download' ? onDownload : remedy.kind === 'command' ? onCommand : onDoc;

  return (
    <span className={styles.remedy}>
      <Button
        variant={primary ? 'primary' : 'secondary'}
        size="sm"
        loading={busy && primary}
        disabled={busy}
        onClick={onClick}
      >
        {label}
      </Button>
      {remedy.kind === 'download' && remedy.sourceUrl ? (
        <span className={styles.source}>
          <span className={styles.sourceLabel}>{c('preflight.source')}</span>
          <span className={styles.url} dir="ltr">
            {remedy.sourceUrl}
          </span>
        </span>
      ) : null}
    </span>
  );
}

/** What happened when the button was pressed, named rather than implied. */
function AttemptResult({
  item,
  attempt,
  controller,
}: {
  item: PrerequisiteStatus;
  attempt: InstallAttempt;
  controller: PreflightController;
}) {
  const { c, nameOf } = usePreflightText();
  const { outcome } = attempt;

  if (outcome.ok) {
    return (
      <div className={styles.success} role="status">
        <p className={styles.successText}>{c('preflight.installed', { name: nameOf(item.id) })}</p>
        <p className={styles.fieldLabel}>{c('preflight.savedTo')}</p>
        <code className={styles.mono} dir="ltr">
          {outcome.installedTo}
        </code>
      </div>
    );
  }

  if (outcome.reason === 'digest-unrecorded') {
    return <UnrecordedDigest item={item} attempt={attempt} controller={controller} />;
  }

  if (outcome.reason === 'digest-mismatch') {
    // Never confirmable. There is no control here at all, because there is no circumstance in
    // which the right answer is "install it anyway".
    return (
      <div className={styles.hardFailure} role="alert">
        <p className={styles.failureTitle}>{c('preflight.mismatch.title')}</p>
        <p className={styles.failureBody}>{c('preflight.mismatch.body')}</p>
        <TechnicalDetail digest={outcome.computedSha256} message={outcome.message} />
      </div>
    );
  }

  return (
    <div className={styles.failure} role="status">
      <p className={styles.failureBody}>{reasonText(c, outcome.reason)}</p>
      <TechnicalDetail message={outcome.message} />
    </div>
  );
}

type CopyFn = ReturnType<typeof usePreflightText>['c'];

function reasonText(c: CopyFn, reason: string): string {
  if (reason === 'network') return c('preflight.failed.network');
  if (reason === 'write-failed') return c('preflight.failed.write');
  if (reason === 'declined') return c('preflight.failed.declined');
  if (reason === 'unsupported') return c('preflight.failed.unsupported');
  return c('preflight.failed.generic');
}

/**
 * The case this whole screen exists for.
 *
 * The app fetched a file for which no maintainer ever recorded a digest, so it can prove
 * nothing about it. It says so in one sentence, shows the digest it computed, points at the
 * publisher's own page, and then stops. The confirm control below is the only thing anywhere
 * in this directory that starts an install of an unverified file.
 */
function UnrecordedDigest({
  item,
  attempt,
  controller,
}: {
  item: PrerequisiteStatus;
  attempt: InstallAttempt;
  controller: PreflightController;
}) {
  const { c } = usePreflightText();
  const headingId = useDomId('digest');
  const outcome = attempt.outcome;
  const computed = !outcome.ok ? outcome.computedSha256 : undefined;
  const sourceUrl = attempt.remedy?.sourceUrl ?? findSourceUrl(item);

  // Without the computed digest there is nothing to compare, and a confirm control would be
  // asking the user to vouch for something they cannot see. Fall back to the plain failure.
  if (!computed) {
    return (
      <div className={styles.failure} role="status">
        <p className={styles.failureBody}>{c('preflight.failed.generic')}</p>
        <TechnicalDetail message={!outcome.ok ? outcome.message : undefined} />
      </div>
    );
  }

  return (
    <div className={styles.digest} role="group" aria-labelledby={headingId}>
      <p className={styles.failureTitle} id={headingId}>
        {c('preflight.digest.title')}
      </p>
      <p className={styles.failureBody}>{c('preflight.digest.body')}</p>

      <p className={styles.fieldLabel}>{c('preflight.digest.computed')}</p>
      <code className={styles.mono} dir="ltr">
        {computed}
      </code>

      <p className={styles.failureBody}>{c('preflight.digest.compare')}</p>
      {sourceUrl ? (
        <span className={styles.source}>
          <Button
            variant="secondary"
            size="sm"
            startIcon={<ExternalIcon size={16} />}
            onClick={() => void openInBrowser(sourceUrl)}
          >
            {c('preflight.digest.openPage')}
          </Button>
          <span className={styles.url} dir="ltr">
            {sourceUrl}
          </span>
        </span>
      ) : null}

      <div className={styles.actions}>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void controller.confirmUnrecorded(item.id, attempt.remedy, computed)}
        >
          {c('preflight.digest.confirm')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => controller.forget(item.id)}>
          {c('preflight.digest.discard')}
        </Button>
      </div>

      <TechnicalDetail message={!outcome.ok ? outcome.message : undefined} />
    </div>
  );
}

/** The publisher's page, when the attempt did not carry the remedy it came from. */
function findSourceUrl(item: PrerequisiteStatus): string | undefined {
  return item.remedies.find((remedy) => remedy.kind === 'download' && remedy.sourceUrl)?.sourceUrl;
}

function TechnicalDetail({
  digest,
  message,
  label,
}: {
  digest?: string;
  message?: string;
  label?: string;
}) {
  const { c } = usePreflightText();
  if (!digest && !message) return null;
  return (
    <details className={styles.disclosure}>
      <summary className={styles.summary}>{label ?? c('preflight.details')}</summary>
      {digest ? (
        <code className={styles.mono} dir="ltr">
          {digest}
        </code>
      ) : null}
      {message ? <p className={styles.hint}>{message}</p> : null}
    </details>
  );
}

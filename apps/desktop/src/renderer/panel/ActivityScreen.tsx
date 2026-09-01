import {
  ActivityIcon,
  Button,
  EmptyState,
  Panel,
  RefreshIcon,
  Spinner,
  useFormat,
  useT,
} from '@localcast/ui-kit';
import { activityDetail, activityKey } from '../lib/activity.js';
import { useCopy } from '../lib/copy.js';
import { useLibrary } from '../state/library.js';
import styles from './ActivityScreen.module.css';

/**
 * «فعالیت» — the capped, rolled feed from the operator API.
 *
 * It is a convenience, not an audit trail (the server caps it at 5000 rows and trims), and
 * the wording avoids implying otherwise.
 */
export function ActivityScreen() {
  const t = useT();
  const c = useCopy();
  const format = useFormat();
  const { activity, reloadActivity, loading } = useLibrary();

  return (
    <Panel
      title={t('activity.title')}
      actions={
        <Button
          variant="ghost"
          startIcon={<RefreshIcon size={14} />}
          onClick={() => void reloadActivity()}
        >
          {c('activity.reload')}
        </Button>
      }
    >
      {activity.length === 0 ? (
        loading ? (
          <Spinner labelled />
        ) : (
          <EmptyState icon={<ActivityIcon size={22} />} title={t('activity.empty')} />
        )
      ) : (
        <ol className={styles.feed}>
          {activity.map((entry) => {
            const key = activityKey(entry.kind);
            const detail = activityDetail(entry.detail);
            return (
              <li key={`${entry.at}-${entry.kind}-${entry.deviceId ?? ''}`} className={styles.row}>
                <time className={styles.time} dateTime={new Date(entry.at).toISOString()}>
                  {format.date(entry.at, 'datetime')}
                </time>
                <span className={styles.what}>
                  {/* An unrecognised kind shows its raw identifier rather than disappearing. */}
                  {key ? c(key) : entry.kind}
                </span>
                <span className={styles.who}>
                  {entry.deviceName ?? (entry.deviceId ? entry.deviceId : c('activity.unknownDevice'))}
                </span>
                {detail ? (
                  <span className={styles.detail} title={detail}>
                    {detail}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

import { useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Panel,
  ProgressBar,
  Select,
  UploadIcon,
  formatBytes,
  useT,
} from '@localcast/ui-kit';
import { folderSchema } from '@localcast/contract';
import { useClient, useConnectionState } from '../client/ClientProvider.js';
import { useAsync } from '../hooks/useAsync.js';
import { useAppT } from '../i18n/messages.js';
import { buildHref } from '../router.js';
import { Screen } from '../components/Screen.js';
import { safeRelativePath, uploadFile } from '../uploads/uploader.js';
import styles from './UploadRoute.module.css';

const foldersSchema = folderSchema.array();

type ItemState = 'queued' | 'uploading' | 'complete' | 'error';

interface QueueItem {
  key: string;
  name: string;
  size: number;
  sent: number;
  state: ItemState;
  uploadId: string | null;
  error: string | null;
  file: File;
}

/**
 * Surface 4 — «اشتراک از گوشی».
 *
 * The canvas's language is kept and its claim is not: nothing on this screen says the phone
 * is serving anything. It cannot be a server — no listening socket, no persistent camera-roll
 * access, suspended on lock — so the copy says what actually happens, which is that the files
 * are pushed to the Windows server and everyone else sees them through the one normal path.
 */
export function UploadRoute() {
  const t = useT();
  const at = useAppT();
  const client = useClient();
  const connection = useConnectionState();
  const picker = useRef<HTMLInputElement | null>(null);

  const [folderId, setFolderId] = useState('');
  const [queue, setQueue] = useState<QueueItem[]>([]);

  const folders = useAsync(
    async (signal) => {
      const fetcher = () => client.api.folders({ signal });
      if (client.cache === null) return { value: await fetcher(), stale: false };
      return client.cache.withCache('folders', 'all', foldersSchema, fetcher);
    },
    [client],
  );

  const writable = (folders.value ?? []).filter(
    (folder) => folder.writable && folder.available && folder.mode === 'full',
  );

  function update(key: string, patch: Partial<QueueItem>): void {
    setQueue((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }

  async function start(item: QueueItem, target: string): Promise<void> {
    update(item.key, { state: 'uploading', error: null });
    try {
      const session = await uploadFile({
        api: client.api,
        file: item.file,
        folderId: target,
        relativePath: safeRelativePath(item.name),
        mtime: item.file.lastModified,
        ...(item.uploadId === null ? {} : { uploadId: item.uploadId }),
        onProgress: (progress) => {
          update(item.key, { sent: progress.sent, uploadId: progress.uploadId });
        },
      });
      update(item.key, {
        state: session.status === 'complete' ? 'complete' : 'error',
        sent: session.receivedBytes,
        uploadId: session.id,
      });
    } catch (error: unknown) {
      // The session id is kept on purpose: «ادامهٔ ارسال» resumes it rather than starting a
      // second copy of a file the server has most of.
      update(item.key, { state: 'error', error: messageOf(error) });
    }
  }

  function onPicked(files: FileList | null): void {
    if (files === null || folderId === '') return;
    const added: QueueItem[] = Array.from(files).map((file, index) => ({
      key: `${Date.now()}-${index}-${file.name}`,
      name: file.name,
      size: file.size,
      sent: 0,
      state: 'queued' as const,
      uploadId: null,
      error: null,
      file,
    }));
    setQueue((current) => [...added, ...current]);
    // Sequential, not parallel: four concurrent uploads over one cellular uplink finish no
    // sooner and make every progress bar crawl at once.
    void added.reduce<Promise<void>>(
      (chain, item) => chain.then(() => start(item, folderId)),
      Promise.resolve(),
    );
  }

  return (
    <Screen title={t('upload.title')} back={buildHref('/library')} connection={connection}>
      <div className={styles.stack}>
        <p className={styles.explain}>{at('uploads.explain')}</p>

        {writable.length === 0 ? (
          <EmptyState icon={<UploadIcon size={28} />} title={at('uploads.noWritableFolder')} />
        ) : (
          <>
            <Select
              label={at('uploads.destination')}
              placeholder={t('common.select')}
              options={writable.map((folder) => ({ value: folder.id, label: folder.label }))}
              value={folderId}
              onChange={(event) => setFolderId(event.currentTarget.value)}
            />

            <input
              ref={picker}
              className={styles.picker}
              type="file"
              accept="image/*,video/*"
              multiple
              onChange={(event) => onPicked(event.currentTarget.files)}
              data-testid="upload-picker"
            />
            <Button
              variant="primary"
              fullWidth
              disabled={folderId === ''}
              startIcon={<UploadIcon />}
              onClick={() => picker.current?.click()}
            >
              {at('uploads.pick')}
            </Button>
          </>
        )}

        {queue.length === 0 ? null : (
          <Panel title={at('uploads.queue')}>
            <div className={styles.queue}>
              {queue.map((item) => (
                <Card key={item.key} padding="sm">
                  <div className={styles.item}>
                    <div className={styles.itemHead}>
                      <span className={styles.itemName}>{item.name}</span>
                      <span className={styles.itemSize}>
                        {formatBytes(item.sent)} / {formatBytes(item.size)}
                      </span>
                    </div>
                    <ProgressBar
                      value={item.size === 0 ? null : item.sent / item.size}
                      tone={item.state === 'error' ? 'danger' : item.state === 'complete' ? 'success' : 'accent'}
                      label={
                        item.state === 'complete'
                          ? t('upload.complete')
                          : item.state === 'error'
                            ? at('uploads.failed')
                            : t('upload.uploading')
                      }
                    />
                    {item.state === 'error' ? (
                      <>
                        {item.error === null ? null : <p className={styles.itemError}>{item.error}</p>}
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void start(item, folderId)}
                        >
                          {at('uploads.resume')}
                        </Button>
                      </>
                    ) : null}
                    {item.state === 'complete' ? <Badge tone="success">{t('upload.complete')}</Badge> : null}
                  </div>
                </Card>
              ))}
            </div>
          </Panel>
        )}
      </div>
    </Screen>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { ChevronEndIcon } from '@localcast/ui-kit';
import { useAppT } from '../i18n/messages.js';
import { buildHref } from '../router.js';
import styles from './Breadcrumb.module.css';

export interface BreadcrumbProps {
  folderId: string;
  folderLabel: string;
  /** POSIX-separated, relative to the folder root. Empty at the root. */
  path: string;
}

export interface Crumb {
  label: string;
  /** `null` for the current location, which is not a link. */
  href: string | null;
}

/**
 * Root → folder → each path segment.
 *
 * The path arrives POSIX-separated even on Windows (the contract says so), so this is a
 * `split('/')` and not a platform question.
 */
export function buildCrumbs(
  rootLabel: string,
  folderId: string,
  folderLabel: string,
  path: string,
): Crumb[] {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const crumbs: Crumb[] = [
    { label: rootLabel, href: buildHref('/library') },
    {
      label: folderLabel,
      href: segments.length === 0 ? null : buildHref(`/library/${encodeURIComponent(folderId)}`),
    },
  ];

  let walked = '';
  segments.forEach((segment, index) => {
    walked = walked.length === 0 ? segment : `${walked}/${segment}`;
    crumbs.push({
      label: segment,
      href:
        index === segments.length - 1
          ? null
          : buildHref(`/library/${encodeURIComponent(folderId)}`, { path: walked }),
    });
  });

  return crumbs;
}

export function Breadcrumb({ folderId, folderLabel, path }: BreadcrumbProps) {
  const at = useAppT();
  const crumbs = buildCrumbs(at('library.root'), folderId, folderLabel, path);

  return (
    <nav className={styles.crumbs} aria-label={at('library.breadcrumb')}>
      {crumbs.map((crumb, index) => (
        <span key={`${crumb.label}-${index}`} style={{ display: 'contents' }}>
          {index > 0 ? <ChevronEndIcon size={14} className={styles.sep} /> : null}
          {crumb.href === null ? (
            <span className={`${styles.crumb} ${styles.current}`} aria-current="page">
              {crumb.label}
            </span>
          ) : (
            <a className={styles.crumb} href={crumb.href}>
              {crumb.label}
            </a>
          )}
        </span>
      ))}
    </nav>
  );
}

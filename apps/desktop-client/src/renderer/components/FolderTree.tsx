import { useCallback, useEffect, useState } from 'react';
import { ChevronDownIcon, ChevronEndIcon, FolderIcon, useT } from '@localcast/ui-kit';
import type { Entry, Folder } from '@localcast/contract';
import styles from './FolderTree.module.css';

/**
 * The folder tree down the side of screen 06.
 *
 * Children are fetched when a node is first expanded, never up front. A shared folder can
 * hold tens of thousands of directories, and walking all of them to draw a sidebar would put
 * the whole listing cost on the wrong side of the first paint — over a tailnet hop, for a
 * tree the user is going to look at three rows of.
 *
 * A folder whose drive is unplugged is rendered greyed and unopenable rather than hidden.
 * The spec is explicit: `unavailable` means "the disk is not here", which is a temporary
 * fact about the world, while hiding it would say "this share is gone".
 */

export interface TreeSelection {
  folderId: string;
  /** POSIX-separated and relative to the folder root. Empty means the root itself. */
  path: string;
}

export interface FolderTreeProps {
  folders: Folder[];
  selection: TreeSelection | null;
  onSelect: (selection: TreeSelection) => void;
  loadChildren: (folderId: string, path: string) => Promise<Entry[]>;
}

interface Node {
  key: string;
  folderId: string;
  path: string;
  label: string;
  depth: number;
  available: boolean;
}

function keyOf(folderId: string, path: string): string {
  return `${folderId}:${path}`;
}

export function FolderTree({ folders, selection, onSelect, loadChildren }: FolderTreeProps) {
  const t = useT();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Record<string, Node[]>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());

  // A server switch must not leave the previous server's subtree on screen.
  useEffect(() => {
    setExpanded(new Set());
    setChildren({});
  }, [folders]);

  const expand = useCallback(
    async (node: Node) => {
      const key = node.key;
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      if (children[key] !== undefined) return;

      setLoading((current) => new Set(current).add(key));
      try {
        const entries = await loadChildren(node.folderId, node.path);
        setChildren((current) => ({
          ...current,
          [key]: entries
            .filter((entry) => entry.isDir)
            .map((entry) => ({
              key: keyOf(entry.folderId, entry.path),
              folderId: entry.folderId,
              path: entry.path,
              label: entry.name,
              depth: node.depth + 1,
              available: true,
            })),
        }));
      } catch {
        // An expansion that fails records an empty child list rather than retrying for ever;
        // the row stays clickable and the listing pane shows the real error.
        setChildren((current) => ({ ...current, [key]: [] }));
      } finally {
        setLoading((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [children, loadChildren],
  );

  const rows: Node[] = [];
  const push = (node: Node): void => {
    rows.push(node);
    if (!expanded.has(node.key)) return;
    for (const child of children[node.key] ?? []) push(child);
  };
  for (const folder of folders) {
    push({
      key: keyOf(folder.id, ''),
      folderId: folder.id,
      path: '',
      label: folder.label,
      depth: 0,
      available: folder.available,
    });
  }

  return (
    <ul className={styles.tree} role="tree" aria-label={t('nav.library')}>
      {rows.map((node) => {
        const isSelected =
          selection !== null &&
          selection.folderId === node.folderId &&
          selection.path === node.path;
        const isExpanded = expanded.has(node.key);

        return (
          <li key={node.key} role="treeitem" aria-expanded={isExpanded} aria-selected={isSelected}>
            <div
              className={styles.row}
              data-selected={isSelected || undefined}
              data-unavailable={!node.available || undefined}
              style={{ paddingInlineStart: `${8 + node.depth * 14}px` }}
            >
              <button
                type="button"
                className={styles.twisty}
                aria-label={isExpanded ? t('common.previous') : t('common.next')}
                disabled={!node.available}
                onClick={() => void expand(node)}
              >
                {isExpanded ? <ChevronDownIcon size={14} /> : <ChevronEndIcon size={14} />}
              </button>
              <button
                type="button"
                className={styles.label}
                disabled={!node.available}
                onClick={() => onSelect({ folderId: node.folderId, path: node.path })}
              >
                <FolderIcon size={16} />
                <span className={styles.text}>{node.label}</span>
                {node.available ? null : (
                  <span className={styles.note}>{t('folders.unavailable')}</span>
                )}
                {loading.has(node.key) ? (
                  <span className={styles.note}>{t('common.loading')}</span>
                ) : null}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

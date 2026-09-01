import type { Entry } from '@localcast/contract';
import { FileRow } from '@localcast/ui-kit';
import { navigate } from '../router.js';

/**
 * One row in a list view, bound to a route.
 *
 * The href is passed in rather than derived here, because a row means different things in
 * different places — a hit in search opens the player, the same file inside a folder listing
 * may be a navigation into a directory.
 */
export interface FileListRowProps {
  entry: Entry;
  href: string;
  actions?: React.ReactNode;
}

export function FileListRow({ entry, href, actions }: FileListRowProps) {
  return (
    <FileRow
      entry={{
        id: entry.id,
        name: entry.name,
        kind: entry.kind,
        isDir: entry.isDir,
        size: entry.size,
        mtime: entry.mtime,
        browserPlayable: entry.browserPlayable,
      }}
      onOpen={() => navigate(href)}
      {...(actions === undefined ? {} : { actions })}
    />
  );
}

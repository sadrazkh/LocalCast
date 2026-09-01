/**
 * CSS Modules are resolved by Vite, not by `tsc`, so without this declaration every
 * `import styles from './X.module.css'` in this app is a type error.
 *
 * Typed as an index signature rather than a per-file generated type, matching the kit: a
 * class name that no longer exists should show up as a missing style in review, not as a
 * build failure.
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

declare module '*.css' {
  const content: string;
  export default content;
}

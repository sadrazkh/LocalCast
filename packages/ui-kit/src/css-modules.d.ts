/**
 * CSS Modules are resolved by the consuming bundler (Vite in both apps), not by tsc, so
 * without this declaration every `import styles from './X.module.css'` is a type error.
 *
 * The value is deliberately typed as an index signature rather than a generated per-file
 * type: a missing class name should show up as a missing style in review, not as a build
 * failure in two downstream apps we do not own.
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

/** Plain (non-module) stylesheets are imported purely for their side effect. */
declare module '*.css' {
  const content: string;
  export default content;
}

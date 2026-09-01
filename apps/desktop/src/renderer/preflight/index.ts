/**
 * The prerequisites screen: the first thing the user sees when something the app needs is
 * missing, and the strip that stays behind in the panel when they chose to live without one.
 */
export { PreflightStep } from './PreflightStep.js';
export { PreflightBanner } from './PreflightBanner.js';
export { PrerequisiteCard } from './PrerequisiteCard.js';
export type { PrerequisiteCardProps } from './PrerequisiteCard.js';
export { usePreflight, isOutstanding, isSettling, inSeverityOrder } from './usePreflight.js';
export type { InstallAttempt, PreflightController, PreflightPhase } from './usePreflight.js';
export { usePreflightText, preflightCopy } from './copy.js';
export type { PreflightCopyKey, PreflightText } from './copy.js';
export { getPreflightApi, openInBrowser } from './api.js';
export type { InstallOptions, PreflightApi } from './api.js';

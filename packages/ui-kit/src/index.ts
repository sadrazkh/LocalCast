/**
 * `@localcast/ui-kit` — the shared component library, design tokens and bilingual i18n.
 *
 * Consumers import the stylesheet once, at the top of their entry:
 *
 *     import '@localcast/ui-kit/tokens.css';
 *
 * and wrap their tree in `<LocaleProvider>`, which renders the `.lc-root` element the tokens
 * are scoped to and sets `lang`/`dir` on the document.
 */

// ── i18n ──────────────────────────────────────────────────────────────────────────────
export {
  LocaleProvider,
  catalogues,
  en,
  fa,
  useFormat,
  useLocale,
  useT,
  useTNode,
  DEFAULT_LOCALE,
  LOCALES,
  bcp47,
  directionOf,
  formatAddress,
  formatBytes,
  formatCode,
  formatCount,
  formatDate,
  formatDuration,
  formatPercent,
  toAsciiDigits,
  toPersianDigits,
} from './i18n/index.js';
export type {
  BoundFormatters,
  DateStyle,
  Direction,
  Locale,
  LocaleContextValue,
  LocaleProviderProps,
  MessageKey,
  Messages,
  TranslateFn,
  TranslateNodeFn,
  TranslateVars,
} from './i18n/index.js';

// ── icons ─────────────────────────────────────────────────────────────────────────────
export * from './icons/index.js';

// ── utilities ─────────────────────────────────────────────────────────────────────────
export { cx } from './utils/cx.js';
export type { ClassValue } from './utils/cx.js';
export { useDomId } from './utils/useId.js';

// ── primitives ────────────────────────────────────────────────────────────────────────
export { Badge } from './components/Badge.js';
export type { BadgeProps, BadgeTone } from './components/Badge.js';
export { Button } from './components/Button.js';
export type { ButtonProps, ButtonSize, ButtonVariant } from './components/Button.js';
export { Card } from './components/Card.js';
export type { CardPadding, CardProps } from './components/Card.js';
export { Checkbox } from './components/Checkbox.js';
export type { CheckboxProps } from './components/Checkbox.js';
export { Chip } from './components/Chip.js';
export type { ChipProps } from './components/Chip.js';
export { Dropdown } from './components/Dropdown.js';
export type { DropdownItem, DropdownProps } from './components/Dropdown.js';
export { EmptyState } from './components/EmptyState.js';
export type { EmptyStateProps } from './components/EmptyState.js';
export { Field } from './components/Field.js';
export type { FieldProps } from './components/Field.js';
export { Input } from './components/Input.js';
export type { InputProps, InputSize } from './components/Input.js';
export { Modal } from './components/Modal.js';
export type { ModalProps } from './components/Modal.js';
export { Panel } from './components/Panel.js';
export type { PanelProps } from './components/Panel.js';
export { PasswordInput } from './components/PasswordInput.js';
export type { PasswordInputProps } from './components/PasswordInput.js';
export { ProgressBar } from './components/ProgressBar.js';
export type { ProgressBarProps, ProgressTone } from './components/ProgressBar.js';
export { Radio, RadioGroup } from './components/Radio.js';
export type { RadioGroupProps, RadioOption, RadioProps } from './components/Radio.js';
export { SectionHeader } from './components/SectionHeader.js';
export type { SectionHeaderProps } from './components/SectionHeader.js';
export { Select } from './components/Select.js';
export type { SelectOption, SelectProps } from './components/Select.js';
export { Spinner } from './components/Spinner.js';
export type { SpinnerProps, SpinnerSize } from './components/Spinner.js';
export { StatCard } from './components/StatCard.js';
export type { StatCardProps, StatTone } from './components/StatCard.js';
export { Switch } from './components/Switch.js';
export type { SwitchProps } from './components/Switch.js';
export { Table } from './components/Table.js';
export type { TableColumn, TableProps } from './components/Table.js';
export { TabPanel, Tabs } from './components/Tabs.js';
export type { TabItem, TabPanelProps, TabsProps } from './components/Tabs.js';
export { Toast, ToastViewport } from './components/Toast.js';
export type { ToastProps, ToastTone, ToastViewportProps } from './components/Toast.js';
export { Tooltip } from './components/Tooltip.js';
export type { TooltipProps } from './components/Tooltip.js';

// ── domain components ─────────────────────────────────────────────────────────────────
export { ACCESS_MODES, AccessModeSelector } from './components/AccessModeSelector.js';
export type { AccessModeSelectorProps } from './components/AccessModeSelector.js';
export { ConnectionDot, edgeStateToConnection } from './components/ConnectionDot.js';
export type { ConnectionDotProps, ConnectionState } from './components/ConnectionDot.js';
export { DeviceRow } from './components/DeviceRow.js';
export type { DeviceRowDevice, DeviceRowProps, DeviceStatus } from './components/DeviceRow.js';
export { FileGridItem } from './components/FileGridItem.js';
export type { FileGridItemEntry, FileGridItemProps } from './components/FileGridItem.js';
export { FileRow } from './components/FileRow.js';
export type { FileRowEntry, FileRowProps } from './components/FileRow.js';
export { NavRail } from './components/NavRail.js';
export type { NavRailItem, NavRailProps } from './components/NavRail.js';
export { NetworkModeSettings } from './components/NetworkModeSettings.js';
export type {
  DnsProvider,
  NetworkConfigDraft,
  NetworkModeSettingsProps,
} from './components/NetworkModeSettings.js';
export { PairingCode } from './components/PairingCode.js';
export type { PairingCodeProps } from './components/PairingCode.js';
export { PermissionMatrix } from './components/PermissionMatrix.js';
export type {
  PermissionMatrixDevice,
  PermissionMatrixFolder,
  PermissionMatrixProps,
} from './components/PermissionMatrix.js';
export { PrintDialog } from './components/PrintDialog.js';
export type { PrintDialogProps } from './components/PrintDialog.js';
export { PrintJobStatus } from './components/PrintJobStatus.js';
export type { PrintJobStatusProps } from './components/PrintJobStatus.js';
export { QrFrame } from './components/QrFrame.js';
export type { QrFrameProps } from './components/QrFrame.js';
export { TabBar } from './components/TabBar.js';
export type { TabBarItem, TabBarProps } from './components/TabBar.js';

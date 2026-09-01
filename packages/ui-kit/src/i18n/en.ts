import type { Messages } from './fa.js';

/**
 * English catalogue.
 *
 * This is a translation, not a transliteration: «پوشه‌های اشتراکی» becomes "Shared folders",
 * not "Poosheha-ye Eshteraki". Where Persian uses a phrase that has an established English
 * equivalent in file-sharing UIs, the equivalent wins over a literal rendering — «فقط پخش»
 * is "Stream only", «بسته» is "Closed", «انجام‌شده» is "Done".
 *
 * Typed as `Messages`, so a key missing here fails `tsc`, and a key that does not exist in
 * the Persian catalogue fails too.
 */
export const en: Messages = {
  // ── app ──────────────────────────────────────────────────────────────────────────
  'app.name': 'LocalCast',

  // ── common ───────────────────────────────────────────────────────────────────────
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.confirm': 'Confirm',
  'common.delete': 'Delete',
  'common.edit': 'Edit',
  'common.add': 'Add',
  'common.remove': 'Remove',
  'common.retry': 'Try again',
  'common.loading': 'Loading',
  'common.search': 'Search',
  'common.back': 'Back',
  'common.next': 'Next',
  'common.previous': 'Previous',
  'common.more': 'More',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.none': 'None',
  'common.all': 'All',
  'common.unknown': 'Unknown',
  'common.optional': 'Optional',
  'common.required': 'Required',
  'common.select': 'Select',
  'common.dismiss': 'Dismiss',
  'common.refresh': 'Refresh',

  // ── navigation ───────────────────────────────────────────────────────────────────
  'nav.sharedFolders': 'Shared folders',
  'nav.devices': 'Devices',
  'nav.qrPairing': 'QR pairing',
  'nav.activity': 'Activity',
  'nav.settings': 'Settings',
  'nav.printers': 'Printers',
  'nav.library': 'Library',
  'nav.search': 'Search',
  'nav.offline': 'Offline',
  'nav.servers': 'Servers',
  'nav.primary': 'Primary navigation',

  // ── connection ───────────────────────────────────────────────────────────────────
  'connection.connected': 'Connected',
  'connection.disconnected': 'Disconnected',
  'connection.connecting': 'Connecting',
  'connection.label': 'Connection status',

  // ── access modes ─────────────────────────────────────────────────────────────────
  'access.label': 'Access mode',
  'access.full': 'Full',
  'access.stream': 'Stream only',
  'access.none': 'Closed',
  'access.fullHint': 'List, play, download, print and upload',
  'access.streamHint': 'List and play; no download, no print',
  'access.noneHint': 'The folder is not visible at all',

  // ── permission matrix ────────────────────────────────────────────────────────────
  'permissions.title': 'Device access',
  'permissions.deviceColumn': 'Device',
  'permissions.cellLabel': 'Access of {device} to {folder}',
  'permissions.empty': 'No devices paired yet',

  // ── devices ──────────────────────────────────────────────────────────────────────
  'devices.title': 'Devices',
  'devices.addNew': 'Add a new device',
  'devices.approve': 'Approve',
  'devices.reject': 'Reject',
  'devices.revoke': 'Revoke access',
  'devices.pending': 'Awaiting approval',
  'devices.active': 'Active',
  'devices.revoked': 'Revoked',
  'devices.lastSeen': 'Last seen',
  'devices.neverSeen': 'Never',
  'devices.pairingCode': 'Pairing code',
  'devices.empty': 'No devices paired yet',
  'devices.emptyHint': 'Scan the QR code with the phone camera',
  'devices.platform.ios-pwa': 'iPhone',
  'devices.platform.android-pwa': 'Android',
  'devices.platform.windows': 'Windows',
  'devices.platform.web': 'Browser',
  'devices.platform.webdav': 'WebDAV',

  // ── folders ──────────────────────────────────────────────────────────────────────
  'folders.title': 'Shared folders',
  'folders.add': 'Add folder',
  'folders.unavailable': 'Unavailable',
  'folders.writable': 'Writable',
  'folders.lastIndexed': 'Last indexed',
  'folders.empty': 'Nothing is shared yet',
  'folders.kind.video': 'Video',
  'folders.kind.documents': 'Documents',
  'folders.kind.photos': 'Photos',
  'folders.kind.mixed': 'Mixed',

  // ── files ────────────────────────────────────────────────────────────────────────
  'files.name': 'Name',
  'files.size': 'Size',
  'files.date': 'Date',
  'files.kind': 'Type',
  'files.play': 'Play',
  'files.download': 'Download',
  'files.print': 'Print',
  'files.openInNativePlayer': 'Open in a native player',
  'files.notPlayable': 'This file will not play in the browser',
  'files.noPoster': 'No preview',
  'files.empty': 'This folder is empty',
  'files.folder': 'Folder',
  'files.kind.video': 'Video',
  'files.kind.audio': 'Audio',
  'files.kind.image': 'Image',
  'files.kind.document': 'Document',
  'files.kind.archive': 'Archive',
  'files.kind.other': 'Other',

  // ── printing ─────────────────────────────────────────────────────────────────────
  'print.title': 'Print',
  'print.printer': 'Printer',
  'print.choosePrinter': 'Choose a printer',
  'print.copies': 'Copies',
  'print.color': 'Colour',
  'print.colorColor': 'Colour',
  'print.colorMono': 'Black and white',
  'print.duplex': 'Duplex',
  'print.duplexSimplex': 'Single-sided',
  'print.duplexLong': 'Double-sided, long edge',
  'print.duplexShort': 'Double-sided, short edge',
  'print.pageRange': 'Page range',
  'print.pageRangePlaceholder': '1-4,7',
  'print.pageRangeHint': 'Leave empty for every page',
  'print.submit': 'Send to printer',
  'print.printerOffline': 'Offline or unavailable',
  'print.printerDefault': 'Default',
  'print.status.queued': 'Queued',
  'print.status.printing': 'Printing',
  'print.status.done': 'Done',
  'print.status.error': 'Error',
  'print.status.cancelled': 'Cancelled',
  'print.jobsEmpty': 'Nothing in the queue',
  'print.unprintable': 'This file type cannot be printed; PDF and images only',

  // ── pairing ──────────────────────────────────────────────────────────────────────
  'pairing.title': 'QR pairing',
  'pairing.scanPrompt': 'Scan the code with the phone camera',
  'pairing.viewfinderLabel': 'Camera viewfinder',
  'pairing.codeFallback': '4-character code',
  'pairing.codeFallbackAction': 'Type the 4-character code instead of scanning',
  'pairing.codeLabel': 'Pairing code',
  'pairing.expiresIn': 'Expires in {time}',
  'pairing.expired': 'The code has expired',
  'pairing.regenerate': 'New code',
  'pairing.cameraDenied': 'Camera access was refused',

  // ── network coordination server ──────────────────────────────────────────────────
  'network.title': 'Network coordination server',
  'network.modeDefault': 'LocalCast default',
  'network.modeDefaultHint': 'Nothing to configure; the certificate is issued automatically',
  'network.modeCustom': 'Personal server (Headscale)',
  'network.modeCustomHint': 'Full control, but the certificate has to come from somewhere else',
  'network.controlUrl': 'Control server URL',
  'network.accessKey': 'Access key',
  'network.accessKeyHint': 'Stored encrypted and never written to the logs',
  'network.hostname': 'Hostname',
  'network.expose': 'Exposure',
  'network.exposeTailnet': 'Inside the network only',
  'network.exposeFunnel': 'Public address (Funnel)',
  'network.certStrategy': 'Certificate strategy',
  'network.certControlPlane': 'From the control server',
  'network.certExternalProxy': 'External proxy (Caddy or Nginx)',
  'network.certDns01': 'ACME over DNS-01',
  'network.certDomain': 'Domain',
  'network.dnsProvider': 'DNS provider',
  'network.dnsApiToken': 'API token',
  'network.test': 'Test connection',
  'network.testing': 'Testing…',
  'network.save': 'Save and reconnect',
  'network.restoreDefaults': 'Restore defaults',
  'network.status': 'Status',
  'network.saveBlocked': 'Saving is blocked until the test passes',
  'network.serverAddress': 'Server address',
  'network.publicAddress': 'Public address',
  'network.peers': 'Connected devices',
  'network.certExpires': 'Certificate expires',
  'network.certUnavailableTitle': 'This control server cannot issue a certificate itself',
  'network.certUnavailableBody':
    'Headscale has not implemented /machine/set-dns, so no certificate can come from the control plane. Pick one of the other two routes: an external proxy that terminates TLS in front of this machine, or ACME over DNS-01 on a domain you own.',

  // ── edge state ───────────────────────────────────────────────────────────────────
  'edge.stopped': 'Stopped',
  'edge.starting': 'Starting',
  'edge.login-required': 'Sign-in required',
  'edge.connecting': 'Connecting',
  'edge.obtaining-certificate': 'Obtaining a certificate',
  'edge.connected': 'Connected',
  'edge.error': 'Error',

  // ── activity ─────────────────────────────────────────────────────────────────────
  'activity.title': 'Activity',
  'activity.empty': 'Nothing recorded yet',

  // ── phone upload ─────────────────────────────────────────────────────────────────
  'upload.title': 'Share from phone',
  'upload.pick': 'Pick photos or videos',
  'upload.uploading': 'Uploading',
  'upload.complete': 'Uploaded',
  'upload.aborted': 'Cancelled',

  // ── offline and degradation ──────────────────────────────────────────────────────
  'offline.title': 'The server cannot be reached',
  'offline.body': 'The saved library is shown while reconnection keeps being retried',
  'offline.accessClosed': 'Access was closed',
  'offline.folderUnavailable': "This folder's drive is not available",

  // ── generic surfaces ─────────────────────────────────────────────────────────────
  'table.empty': 'Nothing to show',
  'stat.label': 'Statistic',

  // ── accessibility ────────────────────────────────────────────────────────────────
  'a11y.revealPassword': 'Show the value',
  'a11y.hidePassword': 'Hide the value',
  'a11y.closeDialog': 'Close the dialogue',
  'a11y.openMenu': 'Open the menu',
  'a11y.progress': 'Progress',
  'a11y.busy': 'Working',
  'a11y.notification': 'Notification',
};

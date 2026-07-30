# Privacy Policy — PokerChase HUD

Last updated: July 30, 2026

PokerChase HUD is an unofficial Chrome extension that displays poker statistics
and manages hand history for PokerChase. This policy describes the data handled
by the extension and the optional external services it uses.

## Data stored locally

The extension stores intercepted PokerChase game events, derived statistics,
hand history, settings, and UI layout in the browser profile. This data remains
local unless the user enables cloud backup or diagnostic reporting.

Local data is retained until the user clears the extension's storage or
uninstalls the extension.

## Optional cloud backup

When the user signs in and uses cloud backup, the extension uses Google
authentication and Firebase to associate and synchronize game events with that
account. The data is used only to restore and synchronize the user's HUD data.
Signing out or uninstalling the extension does not automatically delete an
existing cloud backup.

## Optional diagnostic reporting

Diagnostic reporting is disabled by default. If the user enables it, diagnostic
information is sent to Sentry, an external error-monitoring service operated by
Functional Software, Inc. The information is used to detect failures, diagnose
compatibility changes, and improve extension reliability.

General error reports may include the extension version, execution context,
operation tags, error messages, and stack traces. When an API schema change is
detected, a bounded semantic snapshot of the affected game event may also be
sent. Direct player identifiers are pseudonymized before transmission, and
player names, chat content, credentials, authentication tokens, and the
byte-for-byte raw event are excluded. The client sends a non-routable placeholder
IP address, and the monitoring project also has data and IP-address scrubbing
enabled.

Diagnostic events are retained according to the monitoring project's configured
retention period and are not used for advertising.

## Sharing and sale

Data is shared only with Google/Firebase when the user uses cloud backup and
with Sentry when the user opts in to diagnostic reporting. PokerChase HUD does
not sell personal data or use it for advertising.

## Access and deletion requests

Users can delete local data by clearing the extension's storage or uninstalling
the extension. For access or deletion requests concerning cloud backups or
diagnostic reports, use the support contact published on the PokerChase HUD
Chrome Web Store listing. Do not include private game data in a public issue.

## Changes

Material changes to this policy will be published in this repository and
described in the corresponding GitHub Release.

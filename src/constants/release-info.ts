/**
 * GitHub Releases link and the persisted unread-update marker.
 *
 * Keep this module side-effect free so popup code can reference the Releases
 * URL without importing background-only badge code.
 *
 * The link is deliberately the Releases *index*, not a per-version tag URL:
 * a tag URL 404s whenever the running version has no matching Release (a
 * locally built / unpacked extension, or a Release not published yet), and
 * the index always resolves while still showing the latest notes first.
 */
export const GITHUB_RELEASES_URL = 'https://github.com/solavrc/pokerchase-hud/releases'

/**
 * Legacy key retained so users upgrading from the in-popup release-notes
 * implementation keep their unread marker.
 */
export const UPDATE_INFO_UNSEEN_VERSION_STORAGE_KEY = 'whatsNewUnseenVersion'

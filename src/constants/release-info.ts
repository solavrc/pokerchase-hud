/**
 * GitHub Release links and the persisted unread-update marker.
 *
 * Keep this module side-effect free so popup code can build the running
 * version's Release URL without importing background-only badge code.
 */
const GITHUB_RELEASE_TAG_BASE_URL =
  'https://github.com/solavrc/pokerchase-hud/releases/tag/pokerchase-hud-v'

export const getGitHubReleaseUrl = (version: string): string =>
  `${GITHUB_RELEASE_TAG_BASE_URL}${encodeURIComponent(version)}`

/**
 * Legacy key retained so users upgrading from the in-popup release-notes
 * implementation keep their unread marker.
 */
export const UPDATE_INFO_UNSEEN_VERSION_STORAGE_KEY = 'whatsNewUnseenVersion'

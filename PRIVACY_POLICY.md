# Privacy Policy for bluesky-likes-tab

**Effective Date:** June 6, 2026

## Overview

bluesky-likes-tab is a browser extension that adds a "Likes" tab to Bluesky profile pages. This policy explains what data the extension handles and how.

## Data Collection

**This extension does not collect, store, or transmit any personal information or user data.**

- The extension does not access, read, or store your Bluesky credentials, session tokens, or authentication data.
- It does not use cookies, local storage, or any browser storage APIs.
- It does not include analytics, telemetry, crash reporting, or tracking of any kind.
- It does not communicate with any third-party servers.

## Data Processing

All functionality runs entirely in your browser:

- **Page content:** The extension reads publicly visible Bluesky profile pages (DIDs, handles, avatars, post content) to render a "Likes" tab. This is the same data visible to any visitor.
- **API requests:** The extension fetches publicly available liked-post data from Bluesky's own public API (`public.api.bsky.app`). These requests originate from your browser and go directly to Bluesky's servers. No intermediary is involved.
- **No data leaves your browser:** All data processing, rendering, and API communication happens locally within the extension's content script.

## Permissions

The extension does not request any Chrome permissions beyond the default host permission (`https://bsky.app/*`) implied by its manifest. It does not use:

- `storage`
- `cookies`
- `tabs`
- `webRequest`
- `identity`
- `activeTab`
- Any other privileged Chrome API

## Third-Party Services

The extension does not integrate with or send data to any third-party service, analytics provider, or external server.

## Changes to This Policy

Any updates to this policy will be reflected in this document and published alongside new releases of the extension.

## Contact

For questions about this privacy policy, open an issue on the [GitHub repository](https://github.com/kylefmohr/bluesky-likes-tab).

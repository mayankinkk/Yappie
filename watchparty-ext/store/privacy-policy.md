# Privacy Policy — WatchParty Sync

_Last updated: [DATE]_

WatchParty Sync is a browser extension that keeps playback in sync between people watching the same video. This policy describes exactly what the extension accesses, what it sends, and where it goes.

## What the extension accesses

**On the pages you visit**

- The HTML `<video>` element on the page: its current playback position, whether it is playing or paused, and its duration.
- Nothing else. The extension does not read page text, form contents, browsing history, cookies, or credentials.

**On your device (local storage)**

- A randomly generated identifier, so the relay can tell your clients apart between restarts.
- Your display name, if you set one.
- Your relay server setting, if you overrode the default.

These are stored with `chrome.storage.local` and never leave your device except as described below.

## What is sent to the relay server

When you create or join a room, your client opens a WebSocket to the relay and sends:

- Your randomly generated identifier and display name.
- Playback control events: the page URL and video duration (used only to confirm everyone is on the same title), the current playback position, and whether it is playing.
- Chat messages you type, if you use the chat panel.

The relay fans these out to other members of your room. The relay **does not** receive video, audio, images, page contents, or any streaming-service credentials. Playback itself is unaffected by this extension — everyone plays from their own copy of the video on their own account.

## What is not collected

- No analytics, telemetry, or crash reporting.
- No advertising identifiers or tracking.
- No personal information beyond the display name you choose to type.
- No video content, viewing history, or streaming-service account details.
- Data is not sold, rented, or shared with third parties.

## Data retention

The relay holds rooms in memory only. Restarting the relay erases every room, its roster, and its chat history. Nothing is written to a database or log file.

## Where the data goes

Control events and chat are relayed to other members of the room you are in, and to no one else. Room codes are six characters long and are the only way to enter a room; anyone who has the code can join, so treat an invite link as you would any other private link.

## Third parties

The extension connects only to the relay server you configure (default set in `config.js`). It does not connect to analytics, advertising, or tracking services.

## Changes

If this policy changes, the updated version will be published at this same URL with a revised date.

## Contact

[Your contact email or support URL]

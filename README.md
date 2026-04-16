# Token Counter for Claude

A Google Chrome Extension that provides a real-time token usage tracker for AI assistants like Claude. It helps you monitor your session quotas, weekly quotas, context window, and cache expiration timers seamlessly from your browser.

## Features

- **Real-time Tracking**: Monitor token usage dynamically as you prompt without needing to refresh or guess.
- **Session & Weekly Quotas**: Keeps track of how many tokens you have consumed in your current session and across the week.
- **Context Window Monitoring**: Keep an eye on contextual limits to avoid sudden truncation or loss of flow.
- **Cache Timer**: Visual tracker for cache expirations, helping you optimize cache-aware token costs.

## Installation

1. Clone this repository to your local machine or download the source code as a ZIP file.
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** via the toggle in the top-right corner.
4. Click on **Load unpacked** and select the directory where you extracted or cloned the extension files.
5. The Token Counter extension will now be available in your extensions toolbar!

## Permissions

- `storage`: Required to save token usage analytics securely across sessions.
- `cookies`: Necessary for maintaining active context and session metrics with Claude.
- `alarms`: Used to keep cache expiration timers and intervals precise.
- **Host Permissions**: Restricted strictly to `https://claude.ai/*`.

## Under The Hood

- **Manifest V3**: Built with the modern Chrome Extension platform standard.
- **Service Worker (`background.js`)**: Handles background token aggregation securely and reliably.
- **Data Injection**: Content scripts and injected scripts safely communicate context without exposing sensitive data.

## Contact

If you have any questions, feedback, or would like to get in touch regarding this extension, feel free to reach out:
- **Email**: [satvalite@gmail.com](mailto:satvalite@gmail.com)


## License & Legal

Copyright (c) 2026. All Rights Reserved.

This application and its source code are provided "as is" without warranty of any kind, express or implied.
Up for Testing only

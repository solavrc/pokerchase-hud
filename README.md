# PokerChase HUD

An unofficial Chrome extension providing real-time poker statistics and hand history tracking.

![PokerChase HUD](./README.png)

> **Note**: This codebase was primarily written by [Claude Code](https://claude.ai/code), demonstrating AI-assisted software development capabilities.

## Disclaimer

This is an **unofficial** Chrome extension not affiliated with PokerChase. Use at your own risk. The developers assume no responsibility or liability for any consequences arising from the use of this tool.

## Features

- **Real-time HUD**: Player statistics overlay with 13+ poker metrics
- **Hand History**: Live PokerStars-format hand log with export
- **Flexible Filtering**: Game type and hand count filters
- **Drag & Drop UI**: Customizable HUD positioning
- **Data Export**: JSON and PokerStars formats
- **Cloud Backup**: Automatic backups with cloud sync

## Quick Start

### Prerequisites

- Node.js 16+
- Google Chrome

### Installation

#### Option 1: From Release (Recommended)

1. Download the latest `extension.zip` from [Releases](https://github.com/solavrc/pokerchase-hud/releases)
2. Extract the ZIP file
3. Open `chrome://extensions/`
4. Enable "Developer mode"
5. Click "Load unpacked" and select the extracted folder

#### Option 2: From Source

1. Build from source

```sh
git clone https://github.com/solavrc/pokerchase-hud.git
cd pokerchase-hud
npm install
npm run build
```

2. Open `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked" and select the project folder

## Architecture

![Architecture Diagram](README.drawio.png)

## Documentation

📖 **[Technical Documentation](CLAUDE.md)** - Complete technical reference including:

- Architecture overview and design principles
- Stream processing pipeline details
- Database schema and API reference
- Development guidelines and best practices
- Cloud sync setup and troubleshooting

## Contributing

Contributions are welcome! The codebase uses a modular architecture for easy extension.

📖 **[Contributing Guide](CONTRIBUTING.md)** - Complete guide for adding new statistics with examples and testing requirements

📁 **[Project Structure](docs/implementation/file-organization.md)** - Detailed directory layout and file organization

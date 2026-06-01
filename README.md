# Vertical Video Merger

Local Node.js and FFmpeg app for automatically merging uploaded vertical videos into final MP4 files.

## Requirements

- Node.js 20 or newer
- npm

FFmpeg and FFprobe are installed through npm packages, so a separate system FFmpeg installation is not required.

## Install

```powershell
npm install
npm run build
npm start
```

Open [http://127.0.0.1:5174](http://127.0.0.1:5174).

## Development

```powershell
npm install
npm run dev
```

## Project Data

Uploaded videos and generated exports are stored locally under `server/data/`. They are intentionally excluded from Git because video files can be large and may contain private content.


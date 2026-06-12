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

## Vercel

Vercel can deploy the Vite frontend with these settings:

- Framework Preset: `Vite`
- Build Command: `npm run build`
- Output Directory: `dist`
- Root Directory: `./`

Set `VITE_API_BASE` only if the Node/FFmpeg backend is hosted somewhere else, for example:

```text
VITE_API_BASE=https://your-backend-domain.com
```

The video processing backend uses Express, local file storage, and FFmpeg. For full production video merging, deploy the backend on a normal Node server such as Render, Railway, Fly.io, or a VPS, then point Vercel to it with `VITE_API_BASE`.

## Project Data

Uploaded videos and generated exports are stored locally under `server/data/`. They are intentionally excluded from Git because video files can be large and may contain private content.

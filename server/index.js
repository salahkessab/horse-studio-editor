import archiver from "archiver";
import cors from "cors";
import express from "express";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import multer from "multer";
import { nanoid } from "nanoid";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "server", "data");
const uploadDir = path.join(dataDir, "uploads");
const outputDir = path.join(dataDir, "outputs");
const tempDir = path.join(dataDir, "temp");
const clientDistDir = path.join(rootDir, "dist");

await Promise.all([uploadDir, outputDir, tempDir].map((dir) => fsp.mkdir(dir, { recursive: true })));

const app = express();
const port = Number(process.env.PORT || 5174);
const maxFileSize = 750 * 1024 * 1024;
const maxUploadVideos = 120;
const allowedExtensions = new Set([".mp4", ".mov", ".webm"]);
const jobs = new Map();

app.use(cors());
app.use(express.json({ limit: "4mb" }));
app.use("/media/uploads", express.static(uploadDir));
app.use("/media/outputs", express.static(outputDir));

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${nanoid()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: maxFileSize },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const supported = allowedExtensions.has(ext);
    cb(supported ? null : new Error("Unsupported video format. Use MP4, MOV, or WEBM."), supported);
  }
});

function slugify(value) {
  return String(value || "final-video")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "final-video";
}

function ffprobe(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobeStatic.path, [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath
    ]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || "Failed to read video metadata."));
      resolve(JSON.parse(stdout));
    });
  });
}

function getVideoMetadata(probe) {
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  if (!video) throw new Error("No video stream found.");

  return {
    duration: Number(probe.format.duration || video.duration || 0),
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    codec: video.codec_name || "unknown",
    format: probe.format.format_name?.split(",")[0] || "unknown",
    hasAudio: Boolean(audio)
  };
}

function runFfmpeg(args, onProgress) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      reject(new Error("Missing FFmpeg binary. Reinstall dependencies and try again."));
      return;
    }

    const proc = spawn(ffmpegPath, ["-hide_banner", "-y", ...args]);
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      const match = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (match && onProgress) {
        const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
        onProgress(seconds);
      }
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.split("\n").slice(-8).join("\n") || "FFmpeg processing failed."));
    });
  });
}

function escapeConcatPath(filePath) {
  return `file '${filePath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}

function buildTransformFilter({ fitMode, flipHorizontal, flipVertical, reverse }) {
  const filters = [];

  if (fitMode === "crop") {
    filters.push("scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920");
  } else {
    filters.push(
      "split=2[base][fg]",
      "[base]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=32[bg]",
      "[fg]scale=1080:1920:force_original_aspect_ratio=decrease[fit]",
      "[bg][fit]overlay=(W-w)/2:(H-h)/2"
    );
  }

  if (flipHorizontal) filters.push("hflip");
  if (flipVertical) filters.push("vflip");
  if (reverse) filters.push("reverse");

  return filters.join(",");
}

function resolveVideoEffects(video, payload) {
  const groupEffects = payload.groupEffects || {};
  return {
    fitMode: payload.fitMode === "crop" ? "crop" : "blur",
    flipHorizontal: groupEffects.flipHorizontal ?? Boolean(video.transforms?.flipHorizontal),
    flipVertical: groupEffects.flipVertical ?? Boolean(video.transforms?.flipVertical),
    reverse: groupEffects.reverse ?? Boolean(video.transforms?.reverse)
  };
}

function validateUniqueVideos(videos) {
  const usage = new Map();
  for (const video of videos) {
    const key = String(video.id);
    if (!usage.has(key)) usage.set(key, []);
    usage.get(key).push(video.originalName || key);
  }

  return [...usage.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([id]) => ({ id }));
}

async function processJob(jobId, payload) {
  const job = jobs.get(jobId);
  const workDir = path.join(tempDir, jobId);
  await fsp.mkdir(workDir, { recursive: true });
  job.status = "processing";

  try {
    const files = (payload.videos || []).map((video) => ({
      ...video,
      inputPath: path.join(uploadDir, path.basename(video.serverName))
    }));
    const maxVideosPerMerge = Math.max(1, Number(payload.maxVideosPerMerge || 999));

    if (files.length === 0) throw new Error("No videos uploaded.");
    if (files.length > maxVideosPerMerge) {
      throw new Error(`This batch group has ${files.length} videos. Maximum allowed per merge is ${maxVideosPerMerge}.`);
    }
    const duplicateEntries = validateUniqueVideos(files);
    if (duplicateEntries.length) {
      throw new Error(`Duplicated video used in more than one slot: ${duplicateEntries[0].id}`);
    }

    const totalDuration = files.reduce((sum, video) => sum + Number(video.duration || 0), 0);
    const trimEnabled = Boolean(payload.trim?.enabled);
    const trimDuration = trimEnabled ? Math.max(0.1, Number(payload.trim.duration || totalDuration)) : totalDuration;
    const finalDuration = trimEnabled ? Math.min(trimDuration, totalDuration) : totalDuration;
    const normalizedFiles = [];

    for (let index = 0; index < files.length; index += 1) {
      const video = files[index];
      const outputPath = path.join(workDir, `normalized-${index}.mp4`);
      const options = resolveVideoEffects(video, payload);

      job.stage = `Normalizing ${index + 1} of ${files.length}`;
      job.progress = Math.min(85, Math.round((index / Math.max(files.length, 1)) * 70));

      const args = [
        "-i",
        video.inputPath,
        "-filter_complex",
        `[0:v]${buildTransformFilter(options)},fps=30,format=yuv420p[v]`,
        "-map",
        "[v]",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "18",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        "-shortest",
        outputPath
      ];

      if (options.reverse && video.hasAudio) {
        args.splice(2, 0, "-af", "areverse");
      }

      await runFfmpeg(args, () => {});
      normalizedFiles.push(outputPath);
    }

    const concatFile = path.join(workDir, "concat.txt");
    await fsp.writeFile(concatFile, normalizedFiles.map(escapeConcatPath).join("\n"), "utf8");

    const baseName = slugify(payload.groupName || "final-video");
    const outputName = `${baseName}-${jobId}.mp4`;
    const outputPath = path.join(outputDir, outputName);
    job.stage = trimEnabled ? "Merging and trimming final video" : "Merging final video";
    job.progress = 86;

    const mergeArgs = [
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatFile,
      ...(trimEnabled ? ["-t", String(finalDuration)] : []),
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "18",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      outputPath
    ];

    await runFfmpeg(mergeArgs, (seconds) => {
      job.progress = Math.min(98, 86 + Math.round((seconds / Math.max(finalDuration, 0.1)) * 12));
    });

    const stats = await fsp.stat(outputPath);
    const metadata = getVideoMetadata(await ffprobe(outputPath));
    job.status = "complete";
    job.stage = "Complete";
    job.progress = 100;
    job.result = {
      groupName: payload.groupName || "Final Video",
      url: `/media/outputs/${outputName}`,
      duration: metadata.duration,
      width: metadata.width,
      height: metadata.height,
      size: stats.size,
      sourceVideoIds: files.map((video) => video.id)
    };
  } catch (error) {
    job.status = "error";
    job.stage = "Failed";
    job.error = error.message || "Failed export.";
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    ffmpeg: Boolean(ffmpegPath && fs.existsSync(ffmpegPath)),
    ffprobe: Boolean(ffprobeStatic.path && fs.existsSync(ffprobeStatic.path))
  });
});

app.post("/api/upload", upload.array("videos", maxUploadVideos), async (req, res, next) => {
  try {
    if (!req.files?.length) {
      res.status(400).json({ error: "No videos uploaded." });
      return;
    }

    const uploaded = [];
    for (const file of req.files) {
      const probe = await ffprobe(file.path);
      const metadata = getVideoMetadata(probe);
      uploaded.push({
        id: nanoid(),
        originalName: file.originalname,
        serverName: file.filename,
        url: `/media/uploads/${file.filename}`,
        size: file.size,
        ...metadata,
        transforms: {
          flipHorizontal: true,
          flipVertical: false,
          reverse: false
        }
      });
    }

    res.json({ videos: uploaded });
  } catch (error) {
    next(error);
  }
});

app.post("/api/merge", async (req, res) => {
  const videos = Array.isArray(req.body.videos) ? req.body.videos : [];
  if (videos.length === 0) return res.status(400).json({ error: "No videos uploaded." });

  const jobId = nanoid();
  jobs.set(jobId, {
    id: jobId,
    groupName: req.body.groupName || "Final Video",
    status: "queued",
    stage: "Queued",
    progress: 0,
    createdAt: Date.now()
  });

  processJob(jobId, req.body);
  res.json({ jobId });
});

app.get("/api/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found." });
  res.json(job);
});

app.post("/api/download-zip", async (req, res) => {
  const files = Array.isArray(req.body.files) ? req.body.files : [];
  if (!files.length) {
    res.status(400).json({ error: "No exported videos available for ZIP download." });
    return;
  }

  const archive = archiver("zip", { zlib: { level: 9 } });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", "attachment; filename=\"batch-videos.zip\"");
  archive.on("error", (error) => {
    if (!res.headersSent) res.status(500).json({ error: error.message || "Failed to create ZIP." });
  });
  archive.pipe(res);

  for (const file of files) {
    const fileName = path.basename(file.url || "");
    const safePath = path.join(outputDir, fileName);
    if (!safePath.startsWith(outputDir) || !fs.existsSync(safePath)) continue;
    archive.file(safePath, { name: file.downloadName || fileName });
  }

  await archive.finalize();
});

app.delete("/api/project", async (_req, res) => {
  jobs.clear();
  await Promise.all([
    fsp.rm(uploadDir, { recursive: true, force: true }).then(() => fsp.mkdir(uploadDir, { recursive: true })),
    fsp.rm(outputDir, { recursive: true, force: true }).then(() => fsp.mkdir(outputDir, { recursive: true })),
    fsp.rm(tempDir, { recursive: true, force: true }).then(() => fsp.mkdir(tempDir, { recursive: true }))
  ]);
  res.json({ ok: true });
});

app.use((error, _req, res, _next) => {
  let message = error.message;
  if (error.code === "LIMIT_FILE_SIZE") {
    message = "Video too large. Maximum size is 750 MB per file.";
  }
  if (error.code === "LIMIT_UNEXPECTED_FILE") {
    message = `Too many videos in one upload. Upload ${maxUploadVideos} videos or fewer at once.`;
  }
  res.status(400).json({ error: message || "Request failed." });
});

if (fs.existsSync(clientDistDir)) {
  app.use(express.static(clientDistDir));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(clientDistDir, "index.html")));
}

app.listen(port, () => {
  console.log(`Video merger server running at http://127.0.0.1:${port}`);
});

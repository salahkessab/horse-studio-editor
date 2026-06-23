import React, { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownUp,
  Check,
  Download,
  Film,
  FolderArchive,
  Loader2,
  RefreshCcw,
  Upload,
  X
} from "lucide-react";
import "./styles.css";

const apiBase = (import.meta.env.VITE_API_BASE || "").replace(/\/$/, "");
const resolutionLabel = "1080 x 1920";
const automaticSettings = {
  targetDuration: 31,
  maxDuration: 35,
  minVideos: 2,
  maxVideos: 999,
  allowShort: true
};
const automaticTrim = { enabled: false, duration: 30 };

function formatDuration(value = 0) {
  const total = Math.max(0, Math.round(value));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatPreciseDuration(value = 0) {
  const safe = Math.max(0, Number(value) || 0);
  return `${safe.toFixed(1)}s`;
}

function formatBytes(bytes = 0) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function makeGroup(videoIds, index) {
  return {
    id: `group-${crypto.randomUUID()}`,
    name: `Final Video ${index + 1}`,
    videoIds,
    effects: {
      flipHorizontal: true,
      flipVertical: false,
      reverse: false
    },
    job: null,
    result: null,
    error: ""
  };
}

function canSplitRemaining(count, minVideos) {
  if (count === 0) return true;
  if (count >= minVideos) return true;
  return count === 1;
}

function buildAutoGroups(videos, settings, startIndex = 0) {
  const groups = [];
  let index = 0;
  const min = Math.max(1, Number(settings.minVideos || 2));
  const max = Math.max(min, Number(settings.maxVideos || 999));
  const target = Math.max(0, Number(settings.targetDuration || 31));
  const maxDuration = Math.max(target, Number(settings.maxDuration || 35));

  while (index < videos.length) {
    const groupVideoIds = [];
    let totalDuration = 0;

    while (index < videos.length && groupVideoIds.length < max) {
      const remainingVideos = videos.length - index;
      const nextVideo = videos[index];
      const nextDuration = totalDuration + nextVideo.duration;
      const remainingAfterSkip = videos.length - index;
      const remainingAfterAdd = videos.length - (index + 1);

      if (
        groupVideoIds.length >= min &&
        totalDuration >= target &&
        totalDuration <= maxDuration &&
        canSplitRemaining(remainingAfterSkip, min)
      ) {
        break;
      }

      if (
        groupVideoIds.length >= min &&
        totalDuration >= min &&
        nextDuration > maxDuration &&
        canSplitRemaining(remainingAfterSkip, min)
      ) {
        break;
      }

      groupVideoIds.push(videos[index].id);
      totalDuration = nextDuration;
      index += 1;

      if (groupVideoIds.length >= min && totalDuration >= target) {
        if (remainingAfterAdd === 0) break;
        if (!canSplitRemaining(remainingAfterAdd, min)) {
          while (index < videos.length && groupVideoIds.length < max) {
            groupVideoIds.push(videos[index].id);
            totalDuration += videos[index].duration;
            index += 1;
          }
          break;
        }
        if (totalDuration >= maxDuration) {
          break;
        }
      }
    }

    groups.push(makeGroup(groupVideoIds, startIndex + groups.length));
  }

  return groups;
}

function chooseVideosToFillShortGroup(currentDuration, candidates, settings) {
  const target = Math.max(0, Number(settings.targetDuration || 31));
  const maxDuration = Math.max(target, Number(settings.maxDuration || 35));
  if (currentDuration >= target) return { fillVideos: [], remainingVideos: candidates };

  let best = null;
  const searchLimit = Math.min(candidates.length, 12);

  function consider(indices) {
    const addedDuration = indices.reduce((sum, index) => sum + Number(candidates[index].duration || 0), 0);
    const finalDuration = currentDuration + addedDuration;
    const inRange = finalDuration >= target && finalDuration <= maxDuration;
    if (!inRange) return;

    if (
      !best ||
      indices.length < best.indices.length ||
      (indices.length === best.indices.length && finalDuration < best.finalDuration)
    ) {
      best = { indices: [...indices], finalDuration };
    }
  }

  function walk(start, picked) {
    if (picked.length > 0) consider(picked);
    if (picked.length >= 6 || start >= searchLimit) return;
    for (let index = start; index < searchLimit; index += 1) {
      picked.push(index);
      walk(index + 1, picked);
      picked.pop();
    }
  }

  walk(0, []);

  if (!best) {
    let total = currentDuration;
    const indices = [];
    for (let index = 0; index < candidates.length; index += 1) {
      indices.push(index);
      total += Number(candidates[index].duration || 0);
      if (total >= target) break;
    }
    best = { indices, finalDuration: total };
  }

  const fillSet = new Set(best.indices);
  return {
    fillVideos: candidates.filter((_, index) => fillSet.has(index)),
    remainingVideos: candidates.filter((_, index) => !fillSet.has(index))
  };
}

function getExpectedDuration(totalDuration, trim) {
  return trim.enabled ? Math.min(totalDuration, Number(trim.duration || 0)) : totalDuration;
}

function collectDuplicateUsage(groups, videosById) {
  const usage = new Map();
  for (const group of groups) {
    for (const videoId of group.videoIds) {
      if (!usage.has(videoId)) usage.set(videoId, []);
      usage.get(videoId).push(group.name);
    }
  }

  return [...usage.entries()]
    .filter(([, groupNames]) => groupNames.length > 1)
    .map(([videoId, groupNames]) => ({
      videoId,
      videoName: videosById.get(videoId)?.originalName || videoId,
      groupNames
    }));
}

function validateGroups(groups, videosById, settings, trim) {
  const errors = [];
  const duplicates = collectDuplicateUsage(groups, videosById);

  if (!groups.length) errors.push("Create at least one final video group before exporting.");
  if (duplicates.length) {
    for (const duplicate of duplicates) {
      errors.push(`${duplicate.videoName} is duplicated in ${duplicate.groupNames.join(" and ")}.`);
    }
  }

  for (const group of groups) {
    const isLastGroup = group === groups[groups.length - 1];
    if (group.videoIds.length < Number(settings.minVideos || 2) && !(isLastGroup && group.videoIds.length === 1)) {
      errors.push(`${group.name} has fewer than ${settings.minVideos} source videos.`);
    }
    if (group.videoIds.length > Number(settings.maxVideos || 3)) {
      errors.push(`${group.name} has more than ${settings.maxVideos} source videos.`);
    }
    const totalDuration = group.videoIds.reduce((sum, videoId) => sum + (videosById.get(videoId)?.duration || 0), 0);
    const expectedDuration = getExpectedDuration(totalDuration, trim);
    if (!settings.allowShort && expectedDuration < Number(settings.targetDuration || 31)) {
      errors.push(`${group.name} is shorter than the target duration.`);
    }
  }

  return { errors, duplicates };
}

function SourceCard({ video }) {
  return (
    <article className="video-card">
      <video src={`${apiBase}${video.url}`} muted controls preload="metadata" />
      <div className="clip-body">
        <div className="clip-title-row">
          <h3 title={video.originalName}>{video.originalName}</h3>
          <span className="source-badge">
            <ArrowDownUp size={14} />
            Mirror left/right active
          </span>
        </div>
        <div className="meta-grid meta-grid-wide">
          <span>{formatDuration(video.duration)}</span>
          <span>{formatBytes(video.size)}</span>
          <span>{video.width} x {video.height}</span>
          <span>{video.codec}</span>
          <span>{video.format}</span>
          <span>{video.hasAudio ? "Audio ready" : "No audio"}</span>
        </div>
      </div>
    </article>
  );
}

function FinalVideoCard({ group, videosById, onAddVideos, disabled }) {
  const groupVideos = group.videoIds.map((videoId) => videosById.get(videoId)).filter(Boolean);
  const totalDuration = groupVideos.reduce((sum, video) => sum + video.duration, 0);
  const expectedDuration = getExpectedDuration(totalDuration, automaticTrim);
  const shortWarning = expectedDuration < automaticSettings.targetDuration;
  let statusLabel = "Ready";
  if (group.job?.status === "processing" || group.job?.status === "queued") statusLabel = group.job.stage || "Processing";
  else if (group.error) statusLabel = "Error";
  else if (group.result) statusLabel = "Complete";
  else if (shortWarning) statusLabel = "Short duration warning";

  return (
    <article className="group-card">
      <div className="group-card-head">
        <div>
          <p className="eyebrow">Automatic output</p>
          <h3>{group.name}</h3>
        </div>
        <span className="source-badge">
          <ArrowDownUp size={14} />
          Mirror active
        </span>
      </div>

      <div className="group-metrics">
        <span>{groupVideos.length} videos</span>
        <span>{formatDuration(totalDuration)}</span>
        <span>{resolutionLabel}</span>
      </div>

      <div className="group-list">
        {groupVideos.map((video) => (
          <span key={video.id} className="group-chip">{video.originalName}</span>
        ))}
      </div>

      <div className="group-detail-grid">
        <div>
          <span>Total duration</span>
          <strong>{formatPreciseDuration(totalDuration)}</strong>
        </div>
        <div>
          <span>Expected final</span>
          <strong>{formatPreciseDuration(expectedDuration)}</strong>
        </div>
        <div>
          <span>Output</span>
          <strong>{resolutionLabel}</strong>
        </div>
        <div>
          <span>Status</span>
          <strong>{statusLabel}</strong>
        </div>
      </div>

      <div className="group-effects">
        <span>Mirror left/right</span>
      </div>

      {shortWarning && (
        <div className="short-fix">
          <div className="notice warn">
            <X size={16} />
            This final video is shorter than the 31-second target. Add more clips to this same final video.
          </div>
          {disabled ? (
            <button className="secondary fill-button" type="button" disabled>
              <Upload size={16} />
              Wait for current exports
            </button>
          ) : (
            <label className="secondary fill-button file-label">
              <Upload size={16} />
              Add videos to this final video
              <input
                type="file"
                accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
                multiple
                onChange={(event) => {
                  onAddVideos(group.id, event.target.files);
                  event.target.value = "";
                }}
              />
            </label>
          )}
        </div>
      )}

      {group.error && (
        <div className="notice error">
          <X size={16} />
          {group.error}
        </div>
      )}

      {group.job && (group.job.status === "processing" || group.job.status === "queued") && (
        <div className="progress-box compact">
          <div className="progress-label">
            <span>{group.job.stage}</span>
            <strong>{group.job.progress || 0}%</strong>
          </div>
          <div className="progress-track"><span style={{ width: `${group.job.progress || 0}%` }} /></div>
        </div>
      )}

      {group.result && (
        <div className="group-result">
          <video src={`${apiBase}${group.result.url}`} controls />
          <div className="result-meta">
            <span>{formatPreciseDuration(group.result.duration)}</span>
            <span>{group.result.width} x {group.result.height} px</span>
            <span>{formatBytes(group.result.size)}</span>
          </div>
          <a className="download" href={`${apiBase}${group.result.url}`} download>
            <Download size={16} />
            Download {group.name}
          </a>
        </div>
      )}
    </article>
  );
}

function App() {
  const fileInput = useRef(null);
  const uploadTargetGroup = useRef(null);
  const [videos, setVideos] = useState([]);
  const [groups, setGroups] = useState([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);

  const videosById = useMemo(() => new Map(videos.map((video) => [video.id, video])), [videos]);
  const totalDuration = useMemo(() => videos.reduce((sum, video) => sum + Number(video.duration || 0), 0), [videos]);
  const completedGroups = groups.filter((group) => group.result);
  const validation = useMemo(() => validateGroups(groups, videosById, automaticSettings, automaticTrim), [groups, videosById]);

  function updateGroup(groupId, updater) {
    setGroups((current) => current.map((group) => (
      group.id === groupId ? updater(group) : group
    )));
  }

  function openUpload(targetGroupId = null) {
    uploadTargetGroup.current = targetGroupId;
    fileInput.current?.click();
  }

  function addVideosToGroup(groupId, files) {
    uploadFiles(files, groupId);
  }

  async function waitForJob(jobId, groupId) {
    return new Promise((resolve, reject) => {
      const timer = setInterval(async () => {
        try {
          const next = await api(`/api/jobs/${jobId}`);
          updateGroup(groupId, (group) => ({ ...group, job: next }));
          if (next.status === "complete") {
            clearInterval(timer);
            resolve(next.result);
          }
          if (next.status === "error") {
            clearInterval(timer);
            reject(new Error(next.error || "Failed export."));
          }
        } catch (err) {
          clearInterval(timer);
          reject(err);
        }
      }, 900);
    });
  }

  async function exportOneGroup(group, currentVideosById) {
    const groupVideos = group.videoIds.map((videoId) => currentVideosById.get(videoId)).filter(Boolean);
    updateGroup(group.id, (current) => ({
      ...current,
      error: "",
      result: null,
      job: { status: "queued", stage: "Queued", progress: 0 }
    }));

    const payload = {
      groupName: group.name,
      videos: groupVideos,
      fitMode: "blur",
      trim: automaticTrim,
      groupEffects: group.effects,
      maxVideosPerMerge: automaticSettings.maxVideos
    };

    const { jobId } = await api("/api/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const result = await waitForJob(jobId, group.id);
    updateGroup(group.id, (current) => ({
      ...current,
      result,
      error: "",
      job: null
    }));
  }

  async function generateAllVideos(groupList, videoList, validationGroups = groupList) {
    const currentVideosById = new Map(videoList.map((video) => [video.id, video]));
    const freshValidation = validateGroups(validationGroups, currentVideosById, automaticSettings, automaticTrim);
    if (freshValidation.errors.length) {
      throw new Error(freshValidation.errors[0]);
    }

    setStatus("Exporting all final videos automatically...");
    for (const group of groupList) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await exportOneGroup(group, currentVideosById);
      } catch (err) {
        updateGroup(group.id, (current) => ({ ...current, error: err.message, job: null }));
      }
    }
    setStatus("All final videos are ready to download.");
  }

  async function uploadFiles(files, targetGroupId = null) {
    const accepted = [...files].filter((file) => /\.(mp4|mov|webm)$/i.test(file.name));
    if (accepted.length !== files.length) {
      setError("Unsupported video format. Use MP4, MOV, or WEBM.");
      return;
    }
    if (!targetGroupId && accepted.length < 2) {
      setError("Upload at least 2 videos.");
      return;
    }
    if (targetGroupId && accepted.length < 1) {
      setError("Upload at least 1 video to add to this final video.");
      return;
    }

    setUploading(true);
    setBatchBusy(true);
    setError("");
    setStatus(targetGroupId ? "Reading videos and adding them to the short final video..." : "Reading uploaded videos and creating new final groups...");
    try {
      const form = new FormData();
      accepted.forEach((file) => form.append("videos", file));
      const data = await api("/api/upload", { method: "POST", body: form });
      const uploadedVideos = data.videos.map((video) => ({
        ...video,
        transforms: {
          flipHorizontal: true,
          flipVertical: false,
          reverse: false
        }
      }));
      const mergedVideos = [...videos, ...uploadedVideos];
      if (targetGroupId) {
        const targetGroup = groups.find((group) => group.id === targetGroupId);
        if (!targetGroup) throw new Error("This final video group was not found.");

        const currentDuration = targetGroup.videoIds.reduce((sum, videoId) => sum + (videosById.get(videoId)?.duration || 0), 0);
        const { fillVideos, remainingVideos } = chooseVideosToFillShortGroup(currentDuration, uploadedVideos, automaticSettings);
        if (!fillVideos.length) throw new Error("No videos were added to this final video.");

        const updatedTargetGroup = {
          ...targetGroup,
          videoIds: [...targetGroup.videoIds, ...fillVideos.map((video) => video.id)],
          result: null,
          job: null,
          error: ""
        };
        const newGroups = remainingVideos.length ? buildAutoGroups(remainingVideos, automaticSettings, groups.length) : [];
        const mergedGroups = groups
          .map((group) => (group.id === targetGroupId ? updatedTargetGroup : group))
          .concat(newGroups);

        setVideos(mergedVideos);
        setGroups(mergedGroups);
        setStatus(`Added ${fillVideos.length} video${fillVideos.length === 1 ? "" : "s"} to ${targetGroup.name}. Re-exporting now...`);
        await generateAllVideos([updatedTargetGroup, ...newGroups], mergedVideos, mergedGroups);
      } else {
        const newGroups = buildAutoGroups(uploadedVideos, automaticSettings, groups.length);
        const mergedGroups = [...groups, ...newGroups];
        setVideos(mergedVideos);
        setGroups(mergedGroups);
        setStatus(`Created ${newGroups.length} new final videos automatically. Exporting now...`);
        await generateAllVideos(newGroups, mergedVideos, mergedGroups);
      }
    } catch (err) {
      setError(err.message);
      setStatus("");
    } finally {
      setUploading(false);
      setBatchBusy(false);
    }
  }

  async function downloadAllAsZip() {
    const readyFiles = groups
      .filter((group) => group.result)
      .map((group) => ({
        url: group.result.url,
        downloadName: `${group.name.toLowerCase().replace(/\s+/g, "-")}.mp4`
      }));

    if (!readyFiles.length) {
      setError("No exported videos available for ZIP download.");
      return;
    }

    setError("");
    setStatus("Preparing ZIP download...");
    try {
      const response = await fetch(`${apiBase}/api/download-zip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: readyFiles })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to create ZIP.");
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = "batch-videos.zip";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      setStatus("ZIP download ready.");
    } catch (err) {
      setError(err.message);
    }
  }

  async function clearProject() {
    setVideos([]);
    setGroups([]);
    setError("");
    setStatus("");
    await api("/api/project", { method: "DELETE" }).catch(() => {});
  }

  return (
    <main>
      <section className="topbar">
        <div>
          <p className="eyebrow">Professional vertical merge studio</p>
          <h1>Upload once. Get all final videos automatically.</h1>
        </div>
        <div className="format-pill">
          <Film size={18} />
          <span>{resolutionLabel} MP4</span>
        </div>
      </section>

      <section className="automatic-hero">
        <div className="hero-card">
          <div>
            <p className="eyebrow">Automatic mode</p>
            <h2>Multi-video upload now auto-groups and auto-exports</h2>
            <p className="muted">Mirror left/right stays active by default for every final video. Upload a new batch anytime and the previous final videos stay available.</p>
          </div>
          <div className="hero-stats">
            <span>{videos.length} source videos</span>
            <span>{groups.length} final videos</span>
            <span>{completedGroups.length} ready to download</span>
            <span>{validation.duplicates.length ? "Duplicate source found" : "No duplicate source videos"}</span>
          </div>
          <div className="group-toolbar">
            <button className="primary" type="button" onClick={() => openUpload()} disabled={uploading || batchBusy}>
              {uploading || batchBusy ? <Loader2 className="spin" size={16} /> : <Upload size={16} />}
              Upload Multi Video
            </button>
            <button className="secondary" type="button" disabled={!completedGroups.length} onClick={downloadAllAsZip}>
              <FolderArchive size={16} />
              Download All as ZIP
            </button>
            <button className="secondary" type="button" onClick={clearProject}>
              <RefreshCcw size={16} />
              Clear All
            </button>
          </div>
        </div>
      </section>

      <section className="workspace simple">
        <div className="left-pane">
          <div
            className="upload-zone"
            onDrop={(event) => {
              event.preventDefault();
              uploadFiles(event.dataTransfer.files);
            }}
            onDragOver={(event) => event.preventDefault()}
            onClick={() => openUpload()}
          >
            <input
              ref={fileInput}
              type="file"
              accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
              multiple
              onChange={(event) => {
                const targetGroupId = uploadTargetGroup.current;
                uploadTargetGroup.current = null;
                uploadFiles(event.target.files, targetGroupId);
                event.target.value = "";
              }}
            />
            {uploading ? <Loader2 className="spin" size={34} /> : <Upload size={34} />}
            <div>
              <h2>Drop videos here or browse</h2>
              <p>Upload 2 or more MP4, MOV, or WEBM files. Each upload batch becomes new final video groups, aims for about 31 to 35 seconds when possible, and exports right away without removing your previous results.</p>
            </div>
          </div>

          {status && !error && <div className="notice ok"><Check size={17} />{status}</div>}
          {error && <div className="notice error"><X size={17} />{error}</div>}
          {validation.duplicates.length > 0 && (
            <div className="notice error">
              <X size={16} />
              {validation.duplicates[0].videoName} is duplicated in {validation.duplicates[0].groupNames.join(" and ")}.
            </div>
          )}

          <div className="section-head">
            <div>
              <p className="eyebrow">Source library</p>
              <h2>Uploaded videos</h2>
            </div>
            <div className="section-meta">
              <span>{videos.length} clips</span>
              <span>{formatDuration(totalDuration)}</span>
              <span>Mirror left/right on</span>
            </div>
          </div>

          <div className="clip-list">
            {videos.map((video) => (
              <SourceCard key={video.id} video={video} />
            ))}
          </div>

          <div className="section-head section-head-batch">
            <div>
              <p className="eyebrow">Automatic results</p>
              <h2>Final videos</h2>
            </div>
            <div className="section-meta">
              <span>{groups.length} groups</span>
              <span>{completedGroups.length} ready</span>
              <span>31s to 35s target</span>
            </div>
          </div>

          <div className="group-grid">
            {groups.map((group) => (
              <FinalVideoCard
                key={group.id}
                group={group}
                videosById={videosById}
                onAddVideos={addVideosToGroup}
                disabled={uploading || batchBusy}
              />
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);

// background.js (service worker) - quản lý video, xử lý tải và bypass header

const VIDEO_STORE = new Map(); // key: tabId, value: { videos: Map<id, meta> }
let nextVideoId = 1;

// Lưu metadata request để chỉnh header khi tải
const DOWNLOAD_REQUEST_META = new Map(); // key: downloadUrl, value: { referer, userAgent }

const DEFAULT_FAKE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Worker context trong Manifest V3 không hỗ trợ URL.createObjectURL cho Blob như window.
// Ta chuyển Blob sang data: URL (base64) rồi mới gọi chrome.downloads.download.
async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.length;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  const mime = blob.type || "application/octet-stream";
  return `data:${mime};base64,${base64}`;
}

/**
 * Tạo / lấy store cho 1 tab
 */
function getTabStore(tabId) {
  if (!VIDEO_STORE.has(tabId)) {
    VIDEO_STORE.set(tabId, {
      videos: new Map()
    });
  }
  return VIDEO_STORE.get(tabId);
}

/**
 * Thêm / cập nhật 1 video mới phát hiện
 * payload: { tabId, url, kind, method, size, fragmentCount, extra }
 */
function registerVideo(payload) {
  const { tabId, url, kind, method, size, fragmentCount, extra } = payload;
  if (!url || !tabId) return;

  const store = getTabStore(tabId);

  // Tránh trùng URL cùng loại
  for (const [id, item] of store.videos.entries()) {
    if (item.url === url && item.kind === kind) {
      store.videos.set(id, {
        ...item,
        size: size ?? item.size,
        fragmentCount: fragmentCount ?? item.fragmentCount,
        lastUpdated: Date.now(),
        extra: { ...(item.extra || {}), ...(extra || {}) }
      });
      return id;
    }
  }

  const id = nextVideoId++;
  store.videos.set(id, {
    id,
    url,
    kind,
    method,
    size: size ?? null,
    fragmentCount: fragmentCount ?? null,
    createdAt: Date.now(),
    lastUpdated: Date.now(),
    extra: extra || {}
  });
  return id;
}

/**
 * Xoá dữ liệu khi tab đóng
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  VIDEO_STORE.delete(tabId);
});

/**
 * Lắng nghe message từ content-script & popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type } = message || {};

  if (type === "VIDEO_SNIFFER_REGISTER_VIDEO_FROM_HOOK") {
    const tabId = sender.tab?.id ?? message.tabId;
    if (!tabId) return;

    const id = registerVideo({
      tabId,
      url: message.url,
      kind: message.kind,
      method: message.method,
      size: message.size,
      fragmentCount: message.fragmentCount,
      extra: message.extra
    });

    sendResponse?.({ ok: true, id });
    return true;
  }

  if (type === "VIDEO_SNIFFER_GET_VIDEOS_FOR_TAB") {
    const tabId = message.tabId;
    const store = VIDEO_STORE.get(tabId);
    const videos = store ? Array.from(store.videos.values()) : [];
    sendResponse?.({ ok: true, videos });
    return true;
  }

  if (type === "VIDEO_SNIFFER_DOWNLOAD_DIRECT") {
    const { tabId, videoId } = message;
    const store = VIDEO_STORE.get(tabId);
    if (!store) {
      sendResponse?.({ ok: false, error: "No videos for this tab." });
      return true;
    }
    const video = store.videos.get(videoId);
    if (!video) {
      sendResponse?.({ ok: false, error: "Video not found." });
      return true;
    }

    const filenameSuggestion = buildFileNameFromVideo(video);

    // Ghi meta để onBeforeSendHeaders có thể fake header
    DOWNLOAD_REQUEST_META.set(video.url, {
      referer: video.extra?.referer || video.extra?.pageUrl,
      userAgent: video.extra?.userAgent || DEFAULT_FAKE_UA
    });

    chrome.downloads.download(
      {
        url: video.url,
        filename: filenameSuggestion,
        conflictAction: "uniquify",
        saveAs: true
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse?.({
            ok: false,
            error: chrome.runtime.lastError.message
          });
        } else {
          sendResponse?.({ ok: true, downloadId });
        }
      }
    );
    return true;
  }

  if (type === "VIDEO_SNIFFER_DOWNLOAD_HLS") {
    const { tabId, videoId } = message;
    handleStreamDownload(tabId, videoId, "hls").then(sendResponse);
    return true;
  }

  if (type === "VIDEO_SNIFFER_DOWNLOAD_DASH") {
    const { tabId, videoId } = message;
    handleStreamDownload(tabId, videoId, "dash").then(sendResponse);
    return true;
  }

  if (type === "VIDEO_SNIFFER_DOWNLOAD_MSE_ASSEMBLED") {
    // Nhận buffer từ content-script (ArrayBuffer) và tải dưới dạng data URL
    const { mimeType, buffer, fileNameHint } = message;
    const blob = new Blob([buffer], { type: mimeType || "video/mp4" });
    const fileName =
      fileNameHint ||
      `mse_capture_${new Date().toISOString().replace(/[:.]/g, "_")}.mp4`;

    blobToDataUrl(blob)
      .then((dataUrl) => {
        chrome.downloads.download(
          {
            url: dataUrl,
            filename: fileName,
            conflictAction: "uniquify",
            saveAs: true
          },
          (downloadId) => {
            if (chrome.runtime.lastError) {
              sendResponse?.({
                ok: false,
                error: chrome.runtime.lastError.message
              });
            } else {
              sendResponse?.({ ok: true, downloadId });
            }
          }
        );
      })
      .catch((e) => {
        sendResponse?.({ ok: false, error: String(e) });
      });
    return true;
  }

  return false;
});

/**
 * Xây dựng tên file gợi ý từ metadata
 */
function buildFileNameFromVideo(video) {
  try {
    const urlObj = new URL(video.url);
    const pathname = urlObj.pathname.split("/").filter(Boolean);
    let base = pathname[pathname.length - 1] || "video";
    if (!base.includes(".")) {
      const extFromKind =
        video.kind === "hls"
          ? "ts"
          : video.kind === "dash"
          ? "mp4"
          : "mp4";
      base = `${base}.${extFromKind}`;
    }
    return `video_sniffer/${base}`;
  } catch {
    return "video_sniffer/video.mp4";
  }
}

/**
 * Tải và ghép HLS / DASH stream
 */
async function handleStreamDownload(tabId, videoId, type) {
  const store = VIDEO_STORE.get(tabId);
  if (!store) {
    return { ok: false, error: "No videos for this tab." };
  }
  const video = store.videos.get(videoId);
  if (!video) {
    return { ok: false, error: "Video not found." };
  }

  try {
    const playlistUrl = video.url;
    DOWNLOAD_REQUEST_META.set(playlistUrl, {
      referer: video.extra?.referer || video.extra?.pageUrl,
      userAgent: video.extra?.userAgent || DEFAULT_FAKE_UA
    });

    let result;
    if (type === "hls") {
      const { downloadHlsPlaylistToBlob } = await import(
        chrome.runtime.getURL("hls-downloader.js")
      );
      result = await downloadHlsPlaylistToBlob(playlistUrl, video.extra || {});
    } else {
      const { downloadDashManifestToBlob } = await import(
        chrome.runtime.getURL("dash-downloader.js")
      );
      result = await downloadDashManifestToBlob(
        playlistUrl,
        video.extra || {}
      );
    }

    const { blob, mimeType, filenameHint } = result;
    const fileName =
      filenameHint ||
      buildFileNameFromVideo({
        ...video,
        kind: type === "hls" ? "hls" : "dash"
      });

    const dataUrl = await blobToDataUrl(blob);

    await new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url: dataUrl,
          filename: fileName,
          conflictAction: "uniquify",
          saveAs: true
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(downloadId);
          }
        }
      );
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}


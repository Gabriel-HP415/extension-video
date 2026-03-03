// popup.js
// - Lấy danh sách video của tab hiện tại từ background
// - Render UI + nút Download tương ứng với loại nguồn

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const statusEl = document.getElementById("status");
  const listEl = document.getElementById("video-list");
  const template = document.getElementById("video-item-template");

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  if (!tab) {
    statusEl.textContent = "Không tìm thấy tab hiện tại.";
    return;
  }

  const res = await chrome.runtime.sendMessage({
    type: "VIDEO_SNIFFER_GET_VIDEOS_FOR_TAB",
    tabId: tab.id
  });

  if (!res || !res.ok) {
    statusEl.textContent = "Chưa có video nào được phát hiện.";
    return;
  }

  let videos = res.videos || [];
  if (videos.length === 0) {
    statusEl.textContent = "Chưa phát hiện được video. Hãy reload trang và thử phát video.";
    return;
  }

  // Sắp xếp: ưu tiên direct/hls/dash trước, trong cùng loại thì MSE lớn đứng trên
  const kindPriority = { direct: 0, hls: 1, dash: 2, mse: 3 };
  videos = videos.slice().sort((a, b) => {
    const ka = kindPriority[a.kind] ?? 99;
    const kb = kindPriority[b.kind] ?? 99;
    if (ka !== kb) return ka - kb;
    const sa = a.size || 0;
    const sb = b.size || 0;
    return sb - sa;
  });

  statusEl.textContent = `Đã phát hiện ${videos.length} nguồn video. Thường video chính có dung lượng lớn nhất.`;

  videos.forEach((video) => {
    const node = template.content.firstElementChild.cloneNode(true);

    const urlEl = node.querySelector(".video-url");
    const tagsEl = node.querySelector(".video-tags");
    const btnDownload = node.querySelector(".btn-download");

    urlEl.textContent = video.url;

    const kindTag = document.createElement("span");
    kindTag.className = `tag tag-kind-${video.kind}`;
    kindTag.textContent = video.kind.toUpperCase();
    tagsEl.appendChild(kindTag);

    if (video.method) {
      const m = document.createElement("span");
      m.className = "tag tag-small";
      m.textContent = video.method;
      tagsEl.appendChild(m);
    }

    // Với MSE, hiển thị loại track (VIDEO/AUDIO) dựa trên mimeType
    if (video.kind === "mse" && video.extra && video.extra.mimeType) {
      const typeTag = document.createElement("span");
      typeTag.className = "tag tag-small";
      const lowerMime = video.extra.mimeType.toLowerCase();
      if (lowerMime.includes("video/")) {
        typeTag.textContent = "VIDEO track";
      } else if (lowerMime.includes("audio/")) {
        typeTag.textContent = "AUDIO track";
      } else {
        typeTag.textContent = video.extra.mimeType;
      }
      tagsEl.appendChild(typeTag);
    }

    if (video.fragmentCount != null) {
      const f = document.createElement("span");
      f.className = "tag tag-small";
      f.textContent = `${video.fragmentCount} mảnh`;
      tagsEl.appendChild(f);
    }

    if (video.size != null) {
      const s = document.createElement("span");
      s.className = "tag tag-small";
      s.textContent = formatBytes(video.size);
      tagsEl.appendChild(s);
    }

    // Đổi label nút theo loại nguồn cho dễ hiểu
    if (video.kind === "direct") {
      btnDownload.textContent = "Download file gốc";
    } else if (video.kind === "hls") {
      btnDownload.textContent = "Tải & ghép HLS";
    } else if (video.kind === "dash") {
      btnDownload.textContent = "Tải & ghép DASH";
    } else if (video.kind === "mse") {
      btnDownload.textContent = "Ghép MSE & tải";
    }

    btnDownload.addEventListener("click", async () => {
      btnDownload.disabled = true;
      btnDownload.textContent = "Đang tải...";
      try {
        if (video.kind === "direct") {
          await sendDownloadDirect(tab.id, video.id);
        } else if (video.kind === "hls") {
          await sendDownloadHls(tab.id, video.id);
        } else if (video.kind === "dash") {
          await sendDownloadDash(tab.id, video.id);
        } else if (video.kind === "mse") {
          // Gửi yêu cầu assemble MSE sang page context qua content-script
          await assembleMseStreamInPage(tab.id, video.extra?.streamId);
        }
      } catch (e) {
        console.error("Download error", e);
        alert("Lỗi khi tải: " + e);
      } finally {
        btnDownload.disabled = false;
        btnDownload.textContent = "Download";
      }
    });

    listEl.appendChild(node);
  });
}

async function sendDownloadDirect(tabId, videoId) {
  const res = await chrome.runtime.sendMessage({
    type: "VIDEO_SNIFFER_DOWNLOAD_DIRECT",
    tabId,
    videoId
  });
  if (!res || !res.ok) {
    throw new Error(res?.error || "Download direct thất bại.");
  }
}

async function sendDownloadHls(tabId, videoId) {
  const res = await chrome.runtime.sendMessage({
    type: "VIDEO_SNIFFER_DOWNLOAD_HLS",
    tabId,
    videoId
  });
  if (!res || !res.ok) {
    throw new Error(res?.error || "Download HLS thất bại.");
  }
}

async function sendDownloadDash(tabId, videoId) {
  const res = await chrome.runtime.sendMessage({
    type: "VIDEO_SNIFFER_DOWNLOAD_DASH",
    tabId,
    videoId
  });
  if (!res || !res.ok) {
    throw new Error(res?.error || "Download DASH thất bại.");
  }
}

async function assembleMseStreamInPage(tabId, streamId) {
  // Thực hiện script trên tab hiện tại để gửi message tới mse-hook trong page context
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (sid) => {
      window.postMessage(
        {
          source: "video-sniffer-popup",
          type: "ASSEMBLE_MSE_STREAM",
          streamId: sid
        },
        "*"
      );
    },
    args: [streamId]
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}


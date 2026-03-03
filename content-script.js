// content-script.js
// - Inject các hook vào page context (fetch, XHR, MSE)
// - Lắng nghe window.postMessage từ hook và forward về background
// - Hỗ trợ popup lấy danh sách video, trigger download.

(function () {
  const injectedFlag = "__VIDEO_SNIFFER_HOOKS_INJECTED__";
  if (window[injectedFlag]) return;
  window[injectedFlag] = true;

  const pageUrl = location.href;

  function injectScript(file) {
    try {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL(file);
      s.async = false;
      (document.documentElement || document.head || document.body).appendChild(
        s
      );
      s.parentNode && s.parentNode.removeChild(s);
    } catch (e) {
      console.warn("[VideoSniffer] injectScript error", file, e);
    }
  }

  // Inject hooks càng sớm càng tốt
  injectScript("fetch-hook.js");
  injectScript("xhr-hook.js");
  injectScript("mse-hook.js");

  /**
   * Nhận sự kiện từ hook scripts (ở page context)
   * event.data: { source: 'video-sniffer', type, payload }
   */
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "video-sniffer") return;

    if (data.type === "VIDEO_DISCOVERED") {
      const payload = data.payload || {};
      const kind = payload.kind;

      chrome.runtime.sendMessage({
        type: "VIDEO_SNIFFER_REGISTER_VIDEO_FROM_HOOK",
        url: payload.url,
        kind: kind,
        method: payload.method,
        size: payload.size,
        fragmentCount: payload.fragmentCount,
        extra: {
          ...payload.extra,
          pageUrl,
          userAgent: navigator.userAgent
        }
      });
    } else if (data.type === "MSE_STREAM_METADATA") {
      // metadata của MSE stream (id, mimeType, fragmentCount, totalBytes,…)
      const payload = data.payload || {};
      chrome.runtime.sendMessage({
        type: "VIDEO_SNIFFER_REGISTER_VIDEO_FROM_HOOK",
        url: payload.id || `mse://${pageUrl}#${payload.streamId || ""}`,
        kind: "mse",
        method: "mse-appendBuffer",
        size: payload.totalBytes,
        fragmentCount: payload.fragmentCount,
        extra: {
          ...payload,
          pageUrl
        }
      });
    } else if (data.type === "MSE_STREAM_ASSEMBLED") {
      // Nhận buffer (ArrayBuffer) từ hook để chuyển tiếp sang background tải
      const payload = data.payload || {};
      const buffer = payload.buffer;
      if (buffer) {
        chrome.runtime.sendMessage({
          type: "VIDEO_SNIFFER_DOWNLOAD_MSE_ASSEMBLED",
          buffer,
          mimeType: payload.mimeType,
          fileNameHint: payload.fileNameHint
        });
      }
    }
  });

  /**
   * Bổ sung kênh phát hiện video trực tiếp từ DOM <video>/<source>.
   * Điều này giúp bắt được nhiều video mà trang load qua worker / service worker
   * nhưng cuối cùng gán src trực tiếp cho thẻ <video>.
   */
  function isLikelyVideoUrl(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    if (!/^https?:/.test(lower)) return false;
    return /\.(mp4|webm|mov|avi|mkv|flv|ts)(\?|#|$)/.test(lower);
  }

  function registerElementVideo(url) {
    if (!isLikelyVideoUrl(url)) return;
    chrome.runtime.sendMessage({
      type: "VIDEO_SNIFFER_REGISTER_VIDEO_FROM_HOOK",
      url,
      kind: "direct",
      method: "html-media",
      extra: {
        pageUrl,
        userAgent: navigator.userAgent
      }
    });
  }

  function scanExistingMedia() {
    const videos = document.querySelectorAll("video, audio, source");
    videos.forEach((el) => {
      const src = el.currentSrc || el.src;
      if (src) {
        registerElementVideo(src);
      }
    });
  }

  // Quan sát DOM để bắt các thẻ video/source mới hoặc thay đổi src
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes" && (m.attributeName === "src" || m.attributeName === "srcset")) {
        const target = m.target;
        if (target && (target.tagName === "VIDEO" || target.tagName === "AUDIO" || target.tagName === "SOURCE")) {
          const src = target.currentSrc || target.src;
          if (src) registerElementVideo(src);
        }
      }
      if (m.type === "childList" && (m.addedNodes?.length || 0) > 0) {
        m.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (node.matches && node.matches("video, audio, source")) {
            const src = node.currentSrc || node.src;
            if (src) registerElementVideo(src);
          }
          // Nếu node chứa video bên trong
          const inner = node.querySelectorAll
            ? node.querySelectorAll("video, audio, source")
            : [];
          inner.forEach((el) => {
            const src = el.currentSrc || el.src;
            if (src) registerElementVideo(src);
          });
        });
      }
    }
  });

  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "srcset"]
  });

  // Quét lần đầu sau khi trang load
  if (document.readyState === "complete" || document.readyState === "interactive") {
    scanExistingMedia();
  } else {
    window.addEventListener("DOMContentLoaded", scanExistingMedia, { once: true });
  }

})();


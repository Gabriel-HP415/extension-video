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
      // metadata của MSE stream (id, mimeType, fragmentCount tạm thời,…)
      const payload = data.payload || {};
      chrome.runtime.sendMessage({
        type: "VIDEO_SNIFFER_REGISTER_VIDEO_FROM_HOOK",
        url: payload.id || `mse://${pageUrl}#${payload.streamId || ""}`,
        kind: "mse",
        method: "mse-appendBuffer",
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
   * Lắng nghe message từ popup (thông qua background) nếu cần trong tương lai
   * Hiện popup -> background -> content-script chưa cần kênh đặc biệt nên để trống.
   */
})();


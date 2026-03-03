// fetch-hook.js
// Chạy trong page context, hook window.fetch để:
// - Phát hiện direct video, blob video, HLS (.m3u8), DASH (.mpd) trước khi bị chuyển thành blob.

(function () {
  if (window.__VIDEO_SNIFFER_FETCH_HOOKED__) return;
  window.__VIDEO_SNIFFER_FETCH_HOOKED__ = true;

  const origFetch = window.fetch;

  function isVideoLike(url, contentType) {
    const lowerUrl = (url || "").toLowerCase();
    const lowerType = (contentType || "").toLowerCase();

    if (
      lowerUrl.match(/\.(mp4|webm|mov|avi|mkv|flv|ts)(\?|#|$)/) ||
      lowerType.startsWith("video/")
    ) {
      return "direct";
    }
    if (lowerUrl.match(/\.m3u8(\?|#|$)/) || lowerType.includes("application/vnd.apple.mpegurl")) {
      return "hls";
    }
    if (lowerUrl.match(/\.mpd(\?|#|$)/) || lowerType.includes("application/dash+xml")) {
      return "dash";
    }
    return null;
  }

  window.fetch = function (...args) {
    let request = args[0];
    let url = "";

    try {
      if (typeof request === "string") {
        url = request;
      } else if (request && typeof request === "object") {
        url = request.url;
      }
    } catch {}

    return origFetch.apply(this, args).then((response) => {
      try {
        const resUrl = response.url || url;
        const contentType = response.headers.get("content-type") || "";
        const kind = isVideoLike(resUrl, contentType);

        if (kind === "direct") {
          window.postMessage(
            {
              source: "video-sniffer",
              type: "VIDEO_DISCOVERED",
              payload: {
                url: resUrl,
                kind: "direct",
                method: "fetch",
                extra: {
                  contentType
                }
              }
            },
            "*"
          );
        } else if (kind === "hls") {
          window.postMessage(
            {
              source: "video-sniffer",
              type: "VIDEO_DISCOVERED",
              payload: {
                url: resUrl,
                kind: "hls",
                method: "fetch-m3u8",
                extra: {
                  contentType
                }
              }
            },
            "*"
          );
        } else if (kind === "dash") {
          window.postMessage(
            {
              source: "video-sniffer",
              type: "VIDEO_DISCOVERED",
              payload: {
                url: resUrl,
                kind: "dash",
                method: "fetch-mpd",
                extra: {
                  contentType
                }
              }
            },
            "*"
          );
        }
      } catch (e) {
        console.warn("[VideoSniffer][fetch-hook] error inspecting response", e);
      }

      return response;
    });
  };
})();


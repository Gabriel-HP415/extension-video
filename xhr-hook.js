// xhr-hook.js
// Hook XMLHttpRequest để phát hiện video / stream được tải qua XHR.

(function () {
  if (window.__VIDEO_SNIFFER_XHR_HOOKED__) return;
  window.__VIDEO_SNIFFER_XHR_HOOKED__ = true;

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

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

  XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
    this.__videoSnifferUrl = url;
    this.__videoSnifferMethod = method;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener("loadend", function () {
      try {
        const url = this.responseURL || this.__videoSnifferUrl;
        const headers = this.getAllResponseHeaders() || "";
        const contentTypeMatch = headers
          .split(/\r?\n/)
          .find((h) => h.toLowerCase().startsWith("content-type:"));
        const contentType = contentTypeMatch
          ? contentTypeMatch.split(":").slice(1).join(":").trim()
          : "";

        const kind = isVideoLike(url, contentType);
        if (!kind) return;

        if (kind === "direct") {
          window.postMessage(
            {
              source: "video-sniffer",
              type: "VIDEO_DISCOVERED",
              payload: {
                url,
                kind: "direct",
                method: "xhr",
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
                url,
                kind: "hls",
                method: "xhr-m3u8",
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
                url,
                kind: "dash",
                method: "xhr-mpd",
                extra: {
                  contentType
                }
              }
            },
            "*"
          );
        }
      } catch (e) {
        console.warn("[VideoSniffer][xhr-hook] error inspecting XHR", e);
      }
    });

    return origSend.apply(this, arguments);
  };
})();


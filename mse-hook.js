// mse-hook.js
// Hook MediaSource / SourceBuffer để thu thập fragment video appendBuffer (MSE level 4).
// Cách làm:
// - Gán ID cho mỗi MediaSource + SourceBuffer
// - intercept appendBuffer(arrayBuffer) -> clone data nhỏ hơn giới hạn để tránh tràn bộ nhớ
// - Lưu fragment vào store toàn cục trong page (window.__videoSnifferMSEStore)
// - Gửi metadata sang extension (content-script -> background)
// - Khi user bấm Download MSE (thực tế: ta sẽ cần 1 action riêng trong popup để yêu cầu assemble)

(function () {
  if (window.__VIDEO_SNIFFER_MSE_HOOKED__) return;
  window.__VIDEO_SNIFFER_MSE_HOOKED__ = true;

  // Giới hạn kích thước mỗi stream MSE để tránh tràn bộ nhớ.
  // Ở YouTube, video ~30 phút thường < 300–400MB, nên để 512MB là hợp lý.
  const MAX_TOTAL_BYTES_PER_STREAM = 512 * 1024 * 1024; // ~512MB

  const store = (window.__videoSnifferMSEStore = {
    streams: {}, // streamId -> { mimeType, fragments: [Uint8Array], totalBytes }
    nextStreamId: 1
  });

  function createStream(mimeType) {
    const id = store.nextStreamId++;
    store.streams[id] = {
      id,
      mimeType: mimeType || "video/mp4",
      fragments: [],
      totalBytes: 0
    };
    return id;
  }

  function addFragment(streamId, buffer) {
    const entry = store.streams[streamId];
    if (!entry) return;
    if (!buffer) return;

    const arr =
      buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer || buffer);

    if (entry.totalBytes + arr.byteLength > MAX_TOTAL_BYTES_PER_STREAM) {
      // Nếu vượt quá giới hạn: bỏ qua để tránh crash
      return;
    }

    entry.fragments.push(arr);
    entry.totalBytes += arr.byteLength;

    window.postMessage(
      {
        source: "video-sniffer",
        type: "MSE_STREAM_METADATA",
        payload: {
          id: `mse-stream-${entry.id}`,
          streamId: entry.id,
          mimeType: entry.mimeType,
          fragmentCount: entry.fragments.length,
          totalBytes: entry.totalBytes
        }
      },
      "*"
    );
  }

  function assembleStream(streamId) {
    const entry = store.streams[streamId];
    if (!entry) return null;
    const total = entry.totalBytes;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of entry.fragments) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      mimeType: entry.mimeType || "video/mp4",
      buffer: out.buffer
    };
  }

  // Nghe yêu cầu assemble từ extension (qua content-script -> window.postMessage)
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "video-sniffer-popup") return;
    if (data.type === "ASSEMBLE_MSE_STREAM") {
      const streamId = data.streamId;
      const result = assembleStream(streamId);
      if (result) {
        window.postMessage(
          {
            source: "video-sniffer",
            type: "MSE_STREAM_ASSEMBLED",
            payload: {
              streamId,
              mimeType: result.mimeType,
              buffer: result.buffer,
              fileNameHint: `mse_capture_stream_${streamId}.mp4`
            }
          },
          "*"
        );
      }
    }
  });

  const MediaSourceRef = window.MediaSource || window.WebKitMediaSource;
  if (!MediaSourceRef) {
    return;
  }

  const origAddSourceBuffer = MediaSourceRef.prototype.addSourceBuffer;

  MediaSourceRef.prototype.addSourceBuffer = function (mimeType) {
    const sb = origAddSourceBuffer.call(this, mimeType);
    try {
      const streamId = createStream(mimeType);
      const origAppendBuffer = sb.appendBuffer;

      sb.appendBuffer = function (buffer) {
        try {
          addFragment(streamId, buffer);
        } catch (e) {
          console.warn("[VideoSniffer][mse-hook] appendBuffer capture error", e);
        }
        return origAppendBuffer.apply(this, arguments);
      };
    } catch (e) {
      console.warn("[VideoSniffer][mse-hook] error wrapping SourceBuffer", e);
    }

    return sb;
  };
})();


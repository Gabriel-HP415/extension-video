// hls-downloader.js
// Tải HLS (.m3u8) playlist, parse segment và ghép thành 1 Blob (.ts)
// Ở mức cơ bản, ta concat các .ts segment -> video/mp2t
// Nếu muốn chuyển sang MP4 có thể dùng ffmpeg.wasm trong Web Worker (xem hướng dẫn ở cuối file).

export async function downloadHlsPlaylistToBlob(playlistUrl, options = {}) {
  const { referer, userAgent } = options;

  const text = await fetchWithHeaders(playlistUrl, { referer, userAgent }).then(
    (r) => r.text()
  );

  const baseUrl = new URL(playlistUrl, playlistUrl);
  const lines = text.split(/\r?\n/).map((l) => l.trim());

  const segmentUrls = [];
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const absolute = new URL(line, baseUrl).toString();
    segmentUrls.push(absolute);
  }

  if (segmentUrls.length === 0) {
    throw new Error("Không tìm thấy segment nào trong playlist HLS.");
  }

  const buffers = [];
  let totalBytes = 0;

  for (let i = 0; i < segmentUrls.length; i++) {
    const segUrl = segmentUrls[i];
    const res = await fetchWithHeaders(segUrl, { referer, userAgent });
    const buf = await res.arrayBuffer();
    buffers.push(new Uint8Array(buf));
    totalBytes += buf.byteLength;
  }

  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of buffers) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const blob = new Blob([out.buffer], { type: "video/mp2t" });

  const filenameHint =
    (options.fileNameHint ||
      `hls_${new Date().toISOString().replace(/[:.]/g, "_")}.ts`);

  return {
    blob,
    mimeType: "video/mp2t",
    filenameHint,
    segmentCount: segmentUrls.length
  };
}

async function fetchWithHeaders(url, { referer, userAgent } = {}) {
  const headers = {};
  if (referer) headers["Referer"] = referer;
  if (userAgent) headers["User-Agent"] = userAgent;

  return fetch(url, {
    method: "GET",
    headers
  });
}

/**
 * HƯỚNG DẪN DÙNG ffmpeg.wasm (tuỳ chọn, nâng cao):
 *
 * 1. Tải các file ffmpeg.wasm về và đặt trong thư mục extension, ví dụ:
 *    /ffmpeg/ffmpeg-core.js
 *    /ffmpeg/ffmpeg-core.wasm
 *    /ffmpeg/ffmpeg-core.worker.js
 *
 * 2. Thêm các file đó vào "web_accessible_resources" trong manifest.json.
 *
 * 3. Tạo 1 Web Worker, ví dụ: ffmpeg-worker.js, import ffmpeg.wasm:
 *
 *    importScripts('ffmpeg/ffmpeg-core.js');
 *    // setup FFmpeg.createFFmpeg(...) và nhận message { type: 'hlsToMp4', data: ArrayBuffer }
 *    // rồi postMessage lại { ok: true, buffer: ArrayBufferMp4 }
 *
 * 4. Trong function downloadHlsPlaylistToBlob ở trên,
 *    sau khi có blob TS (video/mp2t), bạn có thể:
 *
 *    - Gửi ArrayBuffer sang worker
 *    - Worker dùng ffmpeg.wasm để chuyển TS -> MP4:
 *      ffmpeg -i input.ts -c copy output.mp4
 *
 * 5. Nhận lại buffer MP4 từ worker và trả về Blob MP4 thay vì TS.
 *
 * Do dung lượng ffmpeg.wasm rất lớn và cấu hình phức tạp,
 * ở đây code mẫu chỉ concat TS và trả về file .ts có thể xem được.
 */


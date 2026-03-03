## Extension: Universal Video Sniffer & Downloader

Extension Microsoft Edge / Chrome (Manifest V3) để phát hiện và tải mọi loại video:

- **Level 1**: Direct video URL (`.mp4`, `.webm`, `.mov`, `.avi`, `.mkv`, `.ts`…)
- **Level 2**: Video blob URL (bắt link thật trước khi page tạo `blob:`)
- **Level 3**: Streaming HLS (`.m3u8`) & DASH (`.mpd`)
- **Level 4**: MediaSource Extension (MSE – `MediaSource.addSourceBuffer`, `SourceBuffer.appendBuffer`)

---

## Cấu trúc thư mục

- `manifest.json` – Manifest V3, khai báo permission, background, content scripts, popup.
- `background.js` – Service worker:
  - Lưu danh sách video theo `tabId`.
  - Nhận sự kiện `VIDEO_SNIFFER_REGISTER_VIDEO_FROM_HOOK` từ `content-script`.
  - Xử lý tải:
    - Direct: `chrome.downloads.download(url)`.
    - HLS: import `hls-downloader.js`, parse `.m3u8` → concat `.ts`.
    - DASH: import `dash-downloader.js`, parse `.mpd` → concat fMP4.
    - MSE: nhận buffer từ `content-script` → tạo `Blob` và tải.
  - Bypass 1 số giới hạn tải với `chrome.webRequest.onBeforeSendHeaders`:
    - Fake `Referer`, `User-Agent`.
    - Giữ cookie / session hiện tại.
    - Loại bớt vài header gây cản trở (vd: `x-content-type-options`).

- `content-script.js`:
  - Inject `fetch-hook.js`, `xhr-hook.js`, `mse-hook.js` vào **page context**.
  - Nghe `window.postMessage` từ các hook và gửi về `background.js` bằng `chrome.runtime.sendMessage`.
  - Chuyển tiếp buffer MSE đã assemble về background để tải.

- `fetch-hook.js`:
  - Hook `window.fetch`.
  - Kiểm tra `response.url` và header `Content-Type`:
    - Direct video → gửi `VIDEO_DISCOVERED` với `kind: "direct"`.
    - `.m3u8` → `kind: "hls"`.
    - `.mpd` → `kind: "dash"`.

- `xhr-hook.js`:
  - Hook `XMLHttpRequest.open/send`.
  - Tương tự `fetch-hook`, phát hiện direct video, HLS, DASH.

- `mse-hook.js`:
  - Hook `MediaSource.prototype.addSourceBuffer` và `SourceBuffer.prototype.appendBuffer`.
  - Gán `streamId` cho mỗi SourceBuffer/video.
  - Clone dữ liệu `appendBuffer` (giới hạn ~100 MB) vào `window.__videoSnifferMSEStore`.
  - Gửi metadata (`MSE_STREAM_METADATA`) sang extension.
  - Khi popup yêu cầu assemble (`ASSEMBLE_MSE_STREAM`), nối tất cả fragment → buffer lớn, gửi lại (`MSE_STREAM_ASSEMBLED`).

- `hls-downloader.js`:
  - Hàm `downloadHlsPlaylistToBlob(playlistUrl, { referer, userAgent })`.
  - Tải `.m3u8`, parse danh sách segment `.ts`, tải từng segment, concat thành `Blob` (`video/mp2t`).

- `dash-downloader.js`:
  - Hàm `downloadDashManifestToBlob(manifestUrl, { referer, userAgent })`.
  - Tải `.mpd`, chọn `AdaptationSet` & `Representation` video đầu tiên.
  - Sử dụng `SegmentTemplate` + `SegmentTimeline` để tính URL segment.
  - Tải init segment + media segment, concat thành `Blob` (`video/mp4`).

- Popup UI:
  - `popup.html` – layout popup.
  - `popup.css` – giao diện tối, hiện đại.
  - `popup.js` – lấy danh sách video từ background, hiển thị, xử lý nút Download.

---

## Cách load extension vào Chrome / Edge

1. Đảm bảo thư mục chứa ít nhất:
   - `manifest.json`
   - `background.js`
   - `content-script.js`
   - `fetch-hook.js`
   - `xhr-hook.js`
   - `mse-hook.js`
   - `hls-downloader.js`
   - `dash-downloader.js`
   - `popup.html`, `popup.js`, `popup.css`

2. **Chrome**:
   - Mở `chrome://extensions/`.
   - Bật **Developer mode** (Chế độ nhà phát triển).
   - Bấm **Load unpacked**.
   - Chọn thư mục extension.

3. **Microsoft Edge**:
   - Mở `edge://extensions/`.
   - Bật **Chế độ nhà phát triển**.
   - Bấm **Tải tiện ích chưa đóng gói**.
   - Chọn thư mục extension.

Nếu Chrome/Edge báo lỗi `icons/...` không tồn tại, hoặc bạn chưa có icon:

- Cách 1: tạo thư mục `icons/` và thêm các file PNG đúng kích thước (16, 32, 48, 128).
- Cách 2: xoá trường `icons` trong `manifest.json`.

---

## Cách test theo từng loại video

### 1. Direct video

- Mở trang có video dạng `<video src="xxx.mp4">` hoặc file `.mp4` trực tiếp.
- Reload trang sau khi cài extension.
- Bấm icon extension để mở popup:
  - Sẽ thấy dòng `DIRECT` kèm URL file.
  - Bấm **Download** để tải file gốc.

### 2. Blob video

- Vào 1 site dùng `URL.createObjectURL(blob)` để phát video.
- Khi site dùng `fetch`/`XHR` tải file video rồi chuyển sang blob:
  - `fetch-hook.js` / `xhr-hook.js` đã bắt được URL gốc ở network.
- Trong popup:
  - Bạn sẽ thấy URL direct tương ứng, không phải `blob:...`.
  - Bấm **Download** để tải file gốc.

### 3. HLS (.m3u8)

- Vào trang dùng HLS (trong Network có `.m3u8`).
- Popup:
  - Thấy dòng `HLS`, `method: fetch-m3u8/xhr-m3u8`.
- Bấm **Download**:
  - Extension tải playlist `.m3u8`, parse segment `.ts`, tải toàn bộ, gộp lại thành 1 file `.ts`.

### 4. DASH (.mpd)

- Vào trang dùng DASH (trong Network có `.mpd`).
- Popup:
  - Thấy dòng `DASH`, `method: fetch-mpd/xhr-mpd`.
- Bấm **Download**:
  - Extension tải `.mpd`, chọn 1 Representation video, tải init + media segment fMP4, concat thành file `.mp4`.

### 5. MSE (MediaSource)

- Vào site sử dụng MSE (được detect trong DevTools > Network/Media).
- Khi player tạo `MediaSource` và gọi `addSourceBuffer`/`appendBuffer`:
  - `mse-hook.js` ghi lại fragment trong bộ nhớ (giới hạn khoảng 100 MB).
  - Gửi metadata (`MSE_STREAM_METADATA`) sang extension.
- Popup:
  - Thấy dòng `MSE` với `fragmentCount`.
- Bấm **Download**:
  - Popup yêu cầu assemble stream trong trang.
  - `mse-hook.js` concat các fragment, gửi buffer về background.
  - Background tạo `Blob` và tải file `.mp4`.

---

## Tùy chọn: tích hợp ffmpeg.wasm (nâng cấp HLS/DASH → MP4 chuẩn)

Mặc định:

- HLS: tạo file `.ts` (MPEG-TS, thường chơi được trong VLC, MPV, ffplay…).
- DASH: concat fMP4 → `.mp4` (thường xem được trên hầu hết player).

Nếu muốn **chuyển HLS sang MP4 bằng ffmpeg.wasm**:

1. Tải bộ ffmpeg.wasm (vd: từ repo `ffmpeg.wasm`) và đặt trong thư mục:
   - `ffmpeg/ffmpeg-core.js`
   - `ffmpeg/ffmpeg-core.wasm`
   - `ffmpeg/ffmpeg-core.worker.js`

2. Cập nhật `manifest.json`:

   - Thêm vào `web_accessible_resources`:

     ```json
     {
       "resources": [
         "ffmpeg/ffmpeg-core.js",
         "ffmpeg/ffmpeg-core.wasm",
         "ffmpeg/ffmpeg-core.worker.js",
         "ffmpeg-worker.js"
       ],
       "matches": ["<all_urls>"]
     }
     ```

3. Tạo file `ffmpeg-worker.js`:

   - Import `ffmpeg-core.js`.
   - Lắng nghe `onmessage`, nhận `ArrayBuffer` chứa `.ts`.
   - Chạy ffmpeg với lệnh tương đương:

   ```bash
   ffmpeg -i input.ts -c copy output.mp4
   ```

   - Gửi lại `ArrayBuffer` của `output.mp4` cho extension.

4. Trong `hls-downloader.js`:

   - Sau khi concat `.ts`, thay vì trả trực tiếp `Blob .ts`:
     - Gửi `ArrayBuffer` sang `ffmpeg-worker.js`.
     - Nhận lại buffer MP4, tạo `Blob` `video/mp4`.

Do bộ ffmpeg.wasm khá nặng và phức tạp, code mẫu hiện tại chỉ dừng ở mức concat segment (đã đủ dùng với nhiều site). Khi cần thực sự chuyển định dạng, bạn có thể bổ sung worker theo hướng dẫn trên.


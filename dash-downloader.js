// dash-downloader.js
// Tải DASH (.mpd) manifest, chọn adaptationSet / representation đơn giản (video đầu tiên),
// parse segment URL và concat thành 1 Blob (fMP4).

export async function downloadDashManifestToBlob(manifestUrl, options = {}) {
  const { referer, userAgent } = options;

  const xmlText = await fetchWithHeaders(manifestUrl, {
    referer,
    userAgent
  }).then((r) => r.text());

  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const baseUrlNode = doc.querySelector("BaseURL");
  const mpdElem = doc.documentElement;

  const mpdUrl = new URL(manifestUrl, manifestUrl);
  const baseUrl = baseUrlNode
    ? new URL(baseUrlNode.textContent.trim(), mpdUrl)
    : mpdUrl;

  const adaptationSetVideo =
    doc.querySelector("AdaptationSet[contentType='video']") ||
    doc.querySelector("AdaptationSet[mimeType^='video/']") ||
    doc.querySelector("AdaptationSet");

  if (!adaptationSetVideo) {
    throw new Error("Không tìm thấy AdaptationSet video trong MPD.");
  }

  const representation =
    adaptationSetVideo.querySelector("Representation") || null;
  if (!representation) {
    throw new Error("Không tìm thấy Representation video trong MPD.");
  }

  const segmentTemplate =
    representation.querySelector("SegmentTemplate") ||
    adaptationSetVideo.querySelector("SegmentTemplate");

  if (!segmentTemplate) {
    throw new Error("Không hỗ trợ MPD không có SegmentTemplate (demo).");
  }

  const mediaTemplate = segmentTemplate.getAttribute("media");
  const initTemplate = segmentTemplate.getAttribute("initialization");
  const timescale = Number(segmentTemplate.getAttribute("timescale") || "1");

  const segmentTimeline = segmentTemplate.querySelector("SegmentTimeline");
  if (!segmentTimeline) {
    throw new Error("Không hỗ trợ MPD không có SegmentTimeline (demo).");
  }

  // Parse SegmentTimeline -> list time indices
  const segments = [];
  let currentTime = 0;
  segmentTimeline.querySelectorAll("S").forEach((s) => {
    const d = Number(s.getAttribute("d"));
    const r = Number(s.getAttribute("r") || "0");
    let tAttr = s.getAttribute("t");
    if (tAttr) {
      currentTime = Number(tAttr);
    }

    const repeat = isNaN(r) ? 0 : r;
    for (let i = 0; i <= repeat; i++) {
      segments.push({ t: currentTime, d });
      currentTime += d;
    }
  });

  if (segments.length === 0) {
    throw new Error("Không tìm thấy segment trong SegmentTimeline.");
  }

  const buffers = [];
  let totalBytes = 0;

  // Tải init segment
  if (initTemplate) {
    const initUrlStr = buildFromTemplate(initTemplate, {
      RepresentationID: representation.getAttribute("id"),
      Number: 0,
      Time: 0
    });
    const initUrl = new URL(initUrlStr, baseUrl).toString();
    const resInit = await fetchWithHeaders(initUrl, { referer, userAgent });
    const bufInit = await resInit.arrayBuffer();
    buffers.push(new Uint8Array(bufInit));
    totalBytes += bufInit.byteLength;
  }

  // Tải media segments
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segUrlStr = buildFromTemplate(mediaTemplate, {
      RepresentationID: representation.getAttribute("id"),
      Number: i + 1,
      Time: seg.t
    });
    const segUrl = new URL(segUrlStr, baseUrl).toString();
    const resSeg = await fetchWithHeaders(segUrl, { referer, userAgent });
    const bufSeg = await resSeg.arrayBuffer();
    buffers.push(new Uint8Array(bufSeg));
    totalBytes += bufSeg.byteLength;
  }

  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of buffers) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const mimeType =
    representation.getAttribute("mimeType") || "video/mp4; codecs=\"avc1\"";
  const blob = new Blob([out.buffer], { type: "video/mp4" });

  const filenameHint =
    options.fileNameHint ||
    `dash_${new Date().toISOString().replace(/[:.]/g, "_")}.mp4`;

  return {
    blob,
    mimeType,
    filenameHint,
    segmentCount: segments.length
  };
}

function buildFromTemplate(tpl, ctx) {
  return tpl
    .replace(/\$RepresentationID\$/g, ctx.RepresentationID || "")
    .replace(/\$Number\$/g, String(ctx.Number))
    .replace(/\$Time\$/g, String(ctx.Time));
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


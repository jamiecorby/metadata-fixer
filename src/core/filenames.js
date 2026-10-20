// Recover capture times from common camera, phone and app file names.
import { naive, plausible } from "./time.js";

const SEP = "(?:[ _T.\\-]|\\s+at\\s+)?";
const FULL = new RegExp("(?:^|[^0-9])((?:19|20)\\d{2})[-_.]?(\\d{2})[-_.]?(\\d{2})" + SEP + "(\\d{2})[-_.:h]?(\\d{2})[-_.:m]?(\\d{2})(?:[._]?(\\d{1,3}))?(?![0-9])");
const DAY = /(?:^|[^0-9])((?:19|20)\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?![0-9])/;
const EPOCH_MS = /(?:^|[^0-9])(1[2-9]\d{11})(?![0-9])/;
const EPOCH_S_PREFIX = /^(?:fb_img_|mmexport|snapchat-|received_|image_?|photo_?|img_?|vid_?|video_?|screenshot_?)?(1[2-9]\d{8})(?:[_\-(].*)?$/i;

const KNOWN = [
  [/^PXL_/i, "Pixel"], [/^IMG-\d{8}-WA/i, "WhatsApp"], [/^VID-\d{8}-WA/i, "WhatsApp"], [/^WhatsApp (?:Image|Video)/i, "WhatsApp"],
  [/^Screenshot|^Screen Shot/i, "Screenshot"], [/^signal-/i, "Signal"], [/^Snapchat-/i, "Snapchat"], [/^FB_IMG_/i, "Facebook"],
  [/^mmexport/i, "WeChat"], [/^(?:IMG|VID)_\d{8}_\d{6}/i, "Android camera"], [/^\d{8}_\d{6}/, "Samsung camera"],
  [/^\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}/, "Dropbox camera upload"], [/^PANO_|^MVIMG_|^BURST/i, "Google camera"],
];
export function sourceName(name) {
  for (const [re, label] of KNOWN) if (re.test(name)) return label;
  return "file name";
}
/**
 * @returns {null | {t:number, utc:boolean, precision:"second"|"day", label:string}}
 *  utc=false: t is wall-clock (naive). utc=true: t is an absolute instant (epoch names).
 */
export function fromFileName(fullName, now = Date.now()) {
  const name = String(fullName).replace(/^.*[\\/]/, "");
  const stem = name.replace(/\.[^.]+$/, "");
  const label = sourceName(name);
  let m = FULL.exec(stem);
  if (m) {
    const t = naive(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
    if (t != null && plausible(t, now)) return { t, utc: false, precision: "second", label };
  }
  m = EPOCH_MS.exec(stem);
  if (m) {
    const t = +m[1];
    if (plausible(t, now)) return { t, utc: true, precision: "second", label: label === "file name" ? "timestamp in file name" : label };
  }
  m = EPOCH_S_PREFIX.exec(stem);
  if (m) {
    const t = +m[1] * 1000;
    if (plausible(t, now)) return { t, utc: true, precision: "second", label: label === "file name" ? "timestamp in file name" : label };
  }
  m = DAY.exec(stem);
  if (m) {
    const t = naive(+m[1], +m[2], +m[3], 12, 0, 0);
    if (t != null && plausible(t, now)) return { t, utc: false, precision: "day", label };
  }
  return null;
}

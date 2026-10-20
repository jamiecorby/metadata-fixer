// iPhone camera profiles by release date (main/wide camera values as written by the stock Camera app).
// [releaseDate, model, lensModel, focalLength(mm), fNumber, focal35mm, iOS at launch]
export const IPHONES = [
  ["2013-09-20", "iPhone 5s", "iPhone 5s back camera 4.12mm f/2.2", 4.12, 2.2, 30, "7.0"],
  ["2014-09-19", "iPhone 6", "iPhone 6 back camera 4.15mm f/2.2", 4.15, 2.2, 29, "8.0"],
  ["2015-09-25", "iPhone 6s", "iPhone 6s back camera 4.15mm f/2.2", 4.15, 2.2, 29, "9.0"],
  ["2016-09-16", "iPhone 7", "iPhone 7 back camera 3.99mm f/1.8", 3.99, 1.8, 28, "10.0"],
  ["2017-09-22", "iPhone 8", "iPhone 8 back camera 3.99mm f/1.8", 3.99, 1.8, 28, "11.0"],
  ["2017-11-03", "iPhone X", "iPhone X back dual camera 4mm f/1.8", 4, 1.8, 28, "11.1"],
  ["2018-09-21", "iPhone XS", "iPhone XS back dual camera 4.25mm f/1.8", 4.25, 1.8, 26, "12.0"],
  ["2019-09-20", "iPhone 11", "iPhone 11 back dual wide camera 4.25mm f/1.8", 4.25, 1.8, 26, "13.0"],
  ["2020-10-23", "iPhone 12", "iPhone 12 back dual wide camera 4.2mm f/1.6", 4.2, 1.6, 26, "14.1"],
  ["2021-09-24", "iPhone 13", "iPhone 13 back dual wide camera 5.1mm f/1.6", 5.1, 1.6, 26, "15.0"],
  ["2022-09-16", "iPhone 14 Pro", "iPhone 14 Pro back triple camera 6.86mm f/1.78", 6.86, 1.78, 24, "16.0"],
  ["2023-09-22", "iPhone 15 Pro", "iPhone 15 Pro back triple camera 6.765mm f/1.78", 6.765, 1.78, 24, "17.0"],
  ["2024-09-20", "iPhone 16 Pro", "iPhone 16 Pro back triple camera 6.765mm f/1.78", 6.765, 1.78, 24, "18.0"],
  ["2025-09-19", "iPhone 17 Pro", "iPhone 17 Pro back triple camera 6.765mm f/1.78", 6.765, 1.78, 24, "26.0"],
].map(([d, model, lens, fl, fn, f35, ios]) => ({ released: Date.parse(d + "T00:00:00Z"), model, lens, fl, fn, f35, ios }));

/** dev: "none" | "era" | model name. t: naive ms (wall clock). */
export function profileFor(dev, t) {
  if (!dev || dev === "none") return null;
  if (dev === "era") {
    if (t == null) return null;
    let best = null;
    for (const p of IPHONES) if (p.released <= t) best = p;
    return best || IPHONES[0];
  }
  return IPHONES.find((p) => p.model === dev) || null;
}

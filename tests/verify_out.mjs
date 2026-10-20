import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { parseMetadata } from "@uswriting/exiftool";
const dir = "tests/out/x";
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
for (const p of walk(dir)) {
  const r = await parseMetadata(new File([readFileSync(p)], p.split("/").pop()), { args: ["-json", "-n", "-G1", "-ExifIFD:DateTimeOriginal", "-ExifIFD:OffsetTimeOriginal", "-XMP-photoshop:DateCreated", "-Composite:GPSLatitude", "-Composite:GPSLongitude", "-GPS:GPSDateStamp", "-GPS:GPSTimeStamp", "-IFD0:Model", "-QuickTime:CreateDate", "-Keys:CreationDate", "-Keys:GPSCoordinates", "-UserData:GPSCoordinates", "-Keys:Model", "-XMP-xmp:Label"], transform: (d) => JSON.parse(d)[0] });
  const d = r.data; delete d.SourceFile;
  console.log(p.replace(dir + "/", ""), JSON.stringify(d));
}

# Subsets IBM Plex (SIL OFL 1.1, from @fontsource) to the characters the interface uses, keeping hinting and kerning.
# Run after changing font versions or UI scripts: python3 scripts/subset-fonts.py  (needs fonttools and brotli).
# Output goes to src/fonts/ and is committed, so the normal build needs no Python.
import subprocess, shutil, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UNICODES = "U+0020-007E,U+00A0-00FF,U+2010-2027,U+2190-2193,U+20AC,U+2122"
for fam, weights in (("sans", (400, 500, 600, 700)), ("mono", (400, 500))):
    for w in weights:
        name = f"ibm-plex-{fam}-latin-{w}-normal.woff2"
        src = os.path.join(ROOT, "node_modules", "@fontsource", f"ibm-plex-{fam}", "files", name)
        subprocess.run(["pyftsubset", src, "--unicodes=" + UNICODES, "--flavor=woff2", "--layout-features=kern,liga,calt",
                        "--output-file=" + os.path.join(ROOT, "src", "fonts", name)], check=True)
shutil.copy(os.path.join(ROOT, "node_modules", "@fontsource", "ibm-plex-sans", "LICENSE"), os.path.join(ROOT, "src", "fonts", "LICENSE-IBM-Plex.txt"))
print("subset", UNICODES)

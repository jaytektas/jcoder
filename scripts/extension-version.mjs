// jcoder — Copyright (C) 2026 Jason Roughley — SPDX-License-Identifier: GPL-3.0-or-later
//
// The Chrome extension's version follows jcoder's: run by `npm version` (the
// "version" script), so the release commit carries both. The Web Store
// needs a higher version for every upload.
import fs from "node:fs";

const file = new URL("../extension/manifest.json", import.meta.url);
const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const text = fs.readFileSync(file, "utf8");
const next = text.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`);
if (next !== text) fs.writeFileSync(file, next);
console.log(`extension version ${version}`);

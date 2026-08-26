#!/usr/bin/env node
/**
 * Fetches the prebuilt opencv2.xcframework the iOS podspec vendors
 * (s.vendored_frameworks = 'opencv2.xcframework').
 *
 * Runs as this package's npm "postinstall" — NOT as a CocoaPods
 * prepare_command, because prepare_command does not run for :path development
 * pods and Expo autolinking consumes this package from node_modules as a
 * :path pod.
 *
 * Dependency-free Node. Also runnable manually:
 *   node scripts/download-opencv-ios.js
 *
 * Env overrides:
 *   EXPO_PANORAMIC_STITCHER_OPENCV_ZIP   path to an already-downloaded zip
 *                                        (offline/air-gapped installs)
 *   EXPO_PANORAMIC_STITCHER_OPENCV_URL   alternate download URL (mirror);
 *                                        disables the checksum pin
 *   EXPO_PANORAMIC_STITCHER_FORCE_IOS_OPENCV=1  run even on non-macOS
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');

// yeatse/opencv-spm release artifact: an Xcode-built opencv2.xcframework with
// ios-arm64 device + ios-arm64_x86_64-simulator slices (the official
// opencv-4.13.0-ios-framework.zip is a legacy fat opencv2.framework with no
// arm64 simulator slice, so it cannot be used).
const OPENCV_VERSION = '4.13.0';
const DEFAULT_URL = `https://github.com/yeatse/opencv-spm/releases/download/${OPENCV_VERSION}/opencv2.xcframework.zip`;
const ZIP_SHA256 = '41fc3bf0f2af1660e24694a3e05d5c56e5869a133cea7084a7e262d54dd5b675';
const ZIP_SIZE_BYTES = 200350637; // ~191 MB

const iosDir = path.join(__dirname, '..', 'ios');
const destDir = path.join(iosDir, 'opencv2.xcframework');
const markerFile = path.join(iosDir, '.opencv2.xcframework.version');
const partialZip = path.join(iosDir, '.opencv2.xcframework.zip.partial');
const extractDir = path.join(iosDir, '.opencv2.xcframework.extract.tmp');

const urlOverride = process.env.EXPO_PANORAMIC_STITCHER_OPENCV_URL;
const localZip = process.env.EXPO_PANORAMIC_STITCHER_OPENCV_ZIP;
const url = urlOverride || DEFAULT_URL;
const markerContent = `${OPENCV_VERSION} ${urlOverride ? 'url-override' : ZIP_SHA256}\n`;

function log(msg) {
  console.log(`[expo-panoramic-stitcher] ${msg}`);
}

function fail(msg) {
  console.error(`\n[expo-panoramic-stitcher] ERROR: ${msg}\n`);
  console.error(
    '[expo-panoramic-stitcher] The iOS build needs ios/opencv2.xcframework. To retry manually:\n' +
      '  node node_modules/@notchip/expo-panoramic-stitcher/scripts/download-opencv-ios.js\n' +
      `Or download ${DEFAULT_URL}\n` +
      'yourself and point EXPO_PANORAMIC_STITCHER_OPENCV_ZIP at the zip file, then rerun the script.\n'
  );
  process.exit(1);
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function download(fromUrl, toFile, redirectsLeft, cb) {
  const req = https.get(fromUrl, { headers: { 'User-Agent': 'expo-panoramic-stitcher-postinstall' } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      if (redirectsLeft <= 0) return cb(new Error('too many redirects'));
      return download(res.headers.location, toFile, redirectsLeft - 1, cb);
    }
    if (res.statusCode !== 200) {
      res.resume();
      return cb(new Error(`HTTP ${res.statusCode} from ${fromUrl}`));
    }
    const out = fs.createWriteStream(toFile);
    res.pipe(out);
    out.on('finish', () => out.close(cb));
    out.on('error', cb);
    res.on('error', cb);
  });
  req.on('error', cb);
  req.setTimeout(120000, () => req.destroy(new Error('download timed out')));
}

function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function findXcframework(root) {
  // The yeatse zip nests the framework under build/; tolerate root level too.
  const direct = path.join(root, 'opencv2.xcframework');
  if (fs.existsSync(direct)) return direct;
  for (const entry of fs.readdirSync(root)) {
    const nested = path.join(root, entry, 'opencv2.xcframework');
    if (fs.existsSync(nested)) return nested;
  }
  return null;
}

function extractAndInstall(zipFile) {
  rmrf(extractDir);
  fs.mkdirSync(extractDir, { recursive: true });
  const unzip = spawnSync('unzip', ['-q', zipFile, '-d', extractDir], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (unzip.error && unzip.error.code === 'ENOENT') {
    fail("the 'unzip' command was not found on PATH (it ships with macOS).");
  }
  const found = findXcframework(extractDir);
  if (!found) {
    fail(`the downloaded zip did not contain opencv2.xcframework (unzip exit ${unzip.status}).`);
  }
  rmrf(destDir);
  fs.renameSync(found, destDir);
  const deviceSlice = path.join(destDir, 'ios-arm64');
  const simSlice = path.join(destDir, 'ios-arm64_x86_64-simulator');
  if (!fs.existsSync(deviceSlice) || !fs.existsSync(simSlice)) {
    rmrf(destDir);
    fail('the extracted opencv2.xcframework is missing the ios-arm64 device or simulator slice.');
  }
  fs.writeFileSync(markerFile, markerContent);
  rmrf(extractDir);
}

function main() {
  if (process.platform !== 'darwin' && process.env.EXPO_PANORAMIC_STITCHER_FORCE_IOS_OPENCV !== '1') {
    log(`skipping iOS OpenCV download on ${process.platform} (only macOS builds iOS).`);
    return;
  }

  if (
    fs.existsSync(destDir) &&
    fs.existsSync(markerFile) &&
    fs.readFileSync(markerFile, 'utf8') === markerContent
  ) {
    log(`opencv2.xcframework ${OPENCV_VERSION} already present — skipping download.`);
    return;
  }

  if (localZip) {
    if (!fs.existsSync(localZip)) fail(`EXPO_PANORAMIC_STITCHER_OPENCV_ZIP points at a missing file: ${localZip}`);
    log(`using local zip ${localZip}`);
    const digest = sha256Of(localZip);
    if (!urlOverride && digest !== ZIP_SHA256) {
      fail(`sha256 mismatch for ${localZip}\n  expected ${ZIP_SHA256}\n  got      ${digest}`);
    }
    extractAndInstall(localZip);
    log(`installed ios/opencv2.xcframework ${OPENCV_VERSION}.`);
    return;
  }

  log(`downloading OpenCV ${OPENCV_VERSION} iOS xcframework (~${Math.round(ZIP_SIZE_BYTES / 1024 / 1024)} MB, one-time)...`);
  log(url);
  rmrf(partialZip);
  download(url, partialZip, 5, (err) => {
    try {
      if (err) fail(`download failed: ${err.message}`);
      if (!urlOverride) {
        const digest = sha256Of(partialZip);
        if (digest !== ZIP_SHA256) {
          fail(`sha256 mismatch for the downloaded zip (corrupt or tampered download)\n  expected ${ZIP_SHA256}\n  got      ${digest}`);
        }
      } else {
        log('URL override in effect — checksum pin skipped.');
      }
      extractAndInstall(partialZip);
      log(`installed ios/opencv2.xcframework ${OPENCV_VERSION}.`);
    } finally {
      rmrf(partialZip);
    }
  });
}

main();

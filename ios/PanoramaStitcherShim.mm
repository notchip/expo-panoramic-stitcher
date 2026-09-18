//
//  PanoramaStitcherShim.mm
//  Objective-C++ implementation. Wraps cv::Stitcher.
//
//  The stitch core below must stay logically identical to the Android JNI shim
//  (android/src/main/cpp/panorama_stitcher_jni.cpp), and the SHARED
//  STITCH-CORE HELPERS block must stay byte-identical. Edit both together.
//

#import "PanoramaStitcherShim.h"

// OpenCV's headers (re)define the macros NO / YES used by Objective-C BOOL.
// Undefine before the import, restore after, so both worlds coexist.
#ifdef NO
#undef NO
#endif
#ifdef YES
#undef YES
#endif

#import <opencv2/opencv.hpp>
#import <opencv2/stitching.hpp>

#ifndef NO
#define NO ((BOOL)0)
#endif
#ifndef YES
#define YES ((BOOL)1)
#endif

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// BEGIN SHARED STITCH-CORE HELPERS
// This block is byte-identical in ios/PanoramaStitcherShim.mm and
// android/src/main/cpp/panorama_stitcher_jni.cpp. Edit both together and diff
// the two blocks (AGENTS.md has the one-liner). Plain C++ only — no ObjC, no JNI.
// ---------------------------------------------------------------------------
namespace {

// Neighbour-only matching mask (StitchOptions.matchNeighbors / matchWrap).
// Pair (i, j) is matched when 0 < |i - j| <= k, plus |i - j| >= n - k when
// wrap is set (the two ends of an ordered sweep). Symmetric, zero diagonal —
// OpenCV's matcher reads the upper triangle. An empty UMat means "match all
// pairs" (OpenCV's default); the caller must skip setMatchingMask then.
cv::UMat buildMatchingMask(int n, int matchNeighbors, bool matchWrap) {
  cv::UMat mask;
  if (matchNeighbors <= 0 || n < 2) {
    return mask;
  }
  cv::Mat m = cv::Mat::zeros(n, n, CV_8U);
  for (int i = 0; i < n; i++) {
    for (int j = 0; j < n; j++) {
      int d = std::abs(i - j);
      if (d == 0) {
        continue;
      }
      if (d <= matchNeighbors || (matchWrap && d >= n - matchNeighbors)) {
        m.at<unsigned char>(i, j) = 1;
      }
    }
  }
  m.copyTo(mask);
  return mask;
}

// Locale-safe JSON numbers. snprintf honours LC_NUMERIC (a de_DE process
// prints "3,14"), so the decimal comma is swapped for a dot; non-finite values
// become null. Never std::to_string(double) here (same locale problem, and
// only 6 digits). %.9g round-trips a float, %.17g a double.
std::string dotDecimal(const char *buf) {
  std::string s(buf);
  std::replace(s.begin(), s.end(), ',', '.');
  return s;
}

std::string jsonDouble(double value) {
  if (!std::isfinite(value)) {
    return "null";
  }
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%.17g", value);
  return dotDecimal(buf);
}

std::string jsonFloat(float value) {
  if (!std::isfinite(value)) {
    return "null";
  }
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%.9g", (double)value);
  return dotDecimal(buf);
}

std::string jsonInt(int value) {
  return std::to_string(value);  // "%d" — locale-independent (no grouping flag)
}

std::string jsonBool(bool value) {
  return value ? "true" : "false";
}

// One composited input image, at compose scale (= full resolution).
struct GeometryCamera {
  int inputIndex = 0;
  int srcWidth = 0;
  int srcHeight = 0;
  double focal = 0;
  double ppx = 0;
  double ppy = 0;
  double aspect = 1;
  float R[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};  // row-major, camera-to-world
  cv::Rect roi;                              // global warped coords
};

struct StitchGeometry {
  bool valid = false;
  std::string projection;  // "spherical" | "cylindrical" | "affine"
  double workScale = 1;
  double warpScale = 1;    // pixels per radian at compose scale
  cv::Point origin;        // detail::resultRoi(corners, sizes).tl()
  cv::Size compositeSize;  // pano size BEFORE the outputWidth resize
  bool selfCheck = false;  // resultRoi(...).size() == compositeSize
  std::vector<GeometryCamera> cameras;
};

// Recover the per-image warp geometry of a successful stitch by replaying what
// cv::Stitcher::composePanorama does internally (verified on OpenCV 4.13):
//  - cameras() are at registration (work) scale; composePanorama scales a
//    private copy by compose_work_aspect = compose_scale / work_scale, and
//    compose_scale is 1 because compositingResol() defaults to ORIG_RESOL;
//  - cameras()[k] pairs POSITIONALLY with the UNSORTED component()[k];
//  - the private warped_image_scale_ is the median camera focal with exactly
//    these float casts (estimateCameraParams);
//  - each image's ROI is warper()->create(warpScale)->warpRoi(size, K, R), and
//    the blender's canvas is detail::resultRoi(corners, sizes) — its origin is
//    what shifts global warped coords to composite pixels. MultiBandBlender
//    crops back to that exact rect, so `selfCheck` compares it with the real
//    (un-resized) pano size.
// Angles are NOT derived here — that interpretation lives in TS (geometry.ts).
// Never throws; returns valid=false on any inconsistency.
StitchGeometry computeStitchGeometry(const cv::Ptr<cv::Stitcher> &stitcher,
                                     const std::vector<cv::Mat> &images,
                                     const std::string &projection,
                                     const cv::Size &panoSize) {
  StitchGeometry g;
  try {
    std::vector<int> component = stitcher->component();  // unsorted on purpose
    std::vector<cv::detail::CameraParams> cameras = stitcher->cameras();
    if (component.empty() || component.size() != cameras.size()) {
      return g;
    }
    double workScale = stitcher->workScale();
    if (!(workScale > 0)) {
      return g;
    }
    double composeWorkAspect = 1.0 / workScale;

    std::vector<double> focals;
    focals.reserve(cameras.size());
    for (const cv::detail::CameraParams &c : cameras) {
      focals.push_back(c.focal);
    }
    std::sort(focals.begin(), focals.end());
    float warpedImageScale;
    if (focals.size() % 2 == 1) {
      warpedImageScale = static_cast<float>(focals[focals.size() / 2]);
    } else {
      warpedImageScale =
          static_cast<float>(focals[focals.size() / 2 - 1] + focals[focals.size() / 2]) * 0.5f;
    }
    float warpScale = static_cast<float>(warpedImageScale * composeWorkAspect);

    cv::Ptr<cv::detail::RotationWarper> w = stitcher->warper()->create(warpScale);
    std::vector<cv::Point> corners(cameras.size());
    std::vector<cv::Size> sizes(cameras.size());
    g.cameras.reserve(cameras.size());
    for (size_t k = 0; k < cameras.size(); k++) {
      int inputIndex = component[k];
      if (inputIndex < 0 || (size_t)inputIndex >= images.size()) {
        return g;
      }
      cv::detail::CameraParams c = cameras[k];
      c.focal *= composeWorkAspect;
      c.ppx *= composeWorkAspect;
      c.ppy *= composeWorkAspect;
      cv::Mat K;
      c.K().convertTo(K, CV_32F);
      cv::Mat R;
      c.R.convertTo(R, CV_32F);
      if (K.rows != 3 || K.cols != 3 || R.rows != 3 || R.cols != 3) {
        return g;
      }
      cv::Size src = images[(size_t)inputIndex].size();
      cv::Rect roi = w->warpRoi(src, K, R);
      corners[k] = roi.tl();
      sizes[k] = roi.size();

      GeometryCamera cam;
      cam.inputIndex = inputIndex;
      cam.srcWidth = src.width;
      cam.srcHeight = src.height;
      cam.focal = c.focal;
      cam.ppx = c.ppx;
      cam.ppy = c.ppy;
      cam.aspect = c.aspect;
      for (int r = 0; r < 3; r++) {
        for (int col = 0; col < 3; col++) {
          cam.R[r * 3 + col] = R.at<float>(r, col);
        }
      }
      cam.roi = roi;
      g.cameras.push_back(cam);
    }
    cv::Rect dst = cv::detail::resultRoi(corners, sizes);
    g.projection = projection;
    g.workScale = workScale;
    g.warpScale = (double)warpScale;
    g.origin = dst.tl();
    g.compositeSize = panoSize;
    g.selfCheck = (dst.size() == panoSize);
    g.valid = true;
  } catch (...) {
    g.valid = false;
    g.cameras.clear();
  }
  return g;
}

// Serialize the geometry (payload version 1) plus the composite->output affine
// X_out = sx * X_comp + tx (tx = ty = 0 today; sx == sy for the isotropic
// outputWidth downscale up to rounding, sx != sy for the legacy autoResize
// stretch, 1/1 when nothing was resized). Compact ASCII, no whitespace.
// Empty string when the geometry is invalid — never fails the stitch.
std::string buildGeometryJson(const StitchGeometry &g, const cv::Size &outputSize) {
  if (!g.valid) {
    return "";
  }
  try {
    double sx = g.compositeSize.width > 0 ? (double)outputSize.width / g.compositeSize.width : 1.0;
    double sy = g.compositeSize.height > 0 ? (double)outputSize.height / g.compositeSize.height : 1.0;
    std::string json;
    json.reserve(512 + g.cameras.size() * 512);
    json += "{\"v\":1,\"projection\":\"" + g.projection + "\"";
    json += ",\"workScale\":" + jsonDouble(g.workScale);
    json += ",\"warpScale\":" + jsonDouble(g.warpScale);
    json += ",\"origin\":{\"x\":" + jsonInt(g.origin.x) + ",\"y\":" + jsonInt(g.origin.y) + "}";
    json += ",\"compositeWidth\":" + jsonInt(g.compositeSize.width);
    json += ",\"compositeHeight\":" + jsonInt(g.compositeSize.height);
    json += ",\"selfCheck\":" + jsonBool(g.selfCheck);
    json += ",\"output\":{\"sx\":" + jsonDouble(sx) + ",\"sy\":" + jsonDouble(sy) +
            ",\"tx\":0,\"ty\":0}";
    json += ",\"cameras\":[";
    for (size_t k = 0; k < g.cameras.size(); k++) {
      const GeometryCamera &c = g.cameras[k];
      if (k > 0) {
        json += ",";
      }
      json += "{\"inputIndex\":" + jsonInt(c.inputIndex);
      json += ",\"srcWidth\":" + jsonInt(c.srcWidth) + ",\"srcHeight\":" + jsonInt(c.srcHeight);
      json += ",\"focal\":" + jsonDouble(c.focal) + ",\"ppx\":" + jsonDouble(c.ppx) +
              ",\"ppy\":" + jsonDouble(c.ppy) + ",\"aspect\":" + jsonDouble(c.aspect);
      json += ",\"R\":[";
      for (int i = 0; i < 9; i++) {
        if (i > 0) {
          json += ",";
        }
        json += jsonFloat(c.R[i]);
      }
      json += "]";
      json += ",\"roi\":{\"x\":" + jsonInt(c.roi.x) + ",\"y\":" + jsonInt(c.roi.y) +
              ",\"width\":" + jsonInt(c.roi.width) + ",\"height\":" + jsonInt(c.roi.height) + "}";
      json += "}";
    }
    json += "]}";
    return json;
  } catch (...) {
    return "";
  }
}

}  // namespace
// ---------------------------------------------------------------------------
// END SHARED STITCH-CORE HELPERS
// ---------------------------------------------------------------------------

NSString *const PanoStitchSuccessKey     = @"success";
NSString *const PanoStitchWidthKey       = @"width";
NSString *const PanoStitchHeightKey      = @"height";
NSString *const PanoStitchUsedIndicesKey = @"usedIndices";
NSString *const PanoStitchGeometryKey    = @"geometryJson";
NSString *const PanoStitchErrorKey       = @"errorMessage";

@implementation PanoramaStitcherShim

+ (NSString *)helloFromOpenCV:(NSString *)name {
  std::string v = cv::getVersionString();
  return [NSString stringWithFormat:@"Hello %@, OpenCV %s is linked ✅", name, v.c_str()];
}

+ (NSString *)openCVVersion {
  return [NSString stringWithUTF8String:cv::getVersionString().c_str()];
}

+ (cv::Stitcher::Mode)modeForWarp:(NSString *)warpMode {
  // PANORAMA mode == spherical/cylindrical projective stitching.
  // SCANS mode == affine, best for flat/plane scans.
  if ([warpMode isEqualToString:@"plane"]) {
    return cv::Stitcher::SCANS;
  }
  return cv::Stitcher::PANORAMA;
}

+ (NSDictionary *)resultWithError:(NSString *)message {
  return @{
    PanoStitchSuccessKey     : @(NO),
    PanoStitchWidthKey       : @(0),
    PanoStitchHeightKey      : @(0),
    PanoStitchUsedIndicesKey : @[],
    PanoStitchGeometryKey    : @"",
    PanoStitchErrorKey       : message ?: @"Unknown error",
  };
}

// Distinct, actionable message per cv::Stitcher::Status. Text must stay
// identical to the Android JNI shim so consumers can match by substring.
+ (NSString *)messageForStatus:(cv::Stitcher::Status)status {
  switch (status) {
    case cv::Stitcher::ERR_NEED_MORE_IMGS:
      return @"Not enough matched images to build a panorama (ERR_NEED_MORE_IMGS). "
              "Ensure 30-40% overlap between adjacent images, or lower panoConfidence.";
    case cv::Stitcher::ERR_HOMOGRAPHY_EST_FAIL:
      return @"Homography estimation failed (ERR_HOMOGRAPHY_EST_FAIL). warpMode 'plane' "
              "assumes a flat/translational scene - use 'spherical' or 'cylindrical' for "
              "rotational captures.";
    case cv::Stitcher::ERR_CAMERA_PARAMS_ADJUST_FAIL:
      return @"Camera parameter adjustment failed (ERR_CAMERA_PARAMS_ADJUST_FAIL). Images "
              "may have too little overlap or too few matched features.";
    default:
      return [NSString stringWithFormat:@"OpenCV stitch failed (status %d).", (int)status];
  }
}

+ (NSDictionary *)stitchImagePaths:(NSArray<NSString *> *)imagePaths
                        outputPath:(NSString *)outputPath
                          warpMode:(NSString *)warpMode
                     blendStrength:(NSInteger)blendStrength
                         matchConf:(float)matchConf
                    panoConfidence:(float)panoConfidence
                    matchNeighbors:(NSInteger)matchNeighbors
                         matchWrap:(BOOL)matchWrap
                       outputWidth:(NSInteger)outputWidth
                        autoResize:(BOOL)autoResize
                       jpegQuality:(NSInteger)jpegQuality {
  try {
    if (imagePaths.count < 2) {
      return [self resultWithError:@"At least 2 images are required"];
    }

    std::vector<cv::Mat> images;
    images.reserve(imagePaths.count);
    for (NSString *path in imagePaths) {
      cv::Mat img = cv::imread([path UTF8String], cv::IMREAD_COLOR);
      if (img.empty()) {
        return [self resultWithError:[NSString stringWithFormat:@"Failed to read image: %@", path]];
      }
      images.push_back(img);
    }

    cv::Stitcher::Mode mode = [self modeForWarp:warpMode];
    cv::Ptr<cv::Stitcher> stitcher = cv::Stitcher::create(mode);

    // matchConf = feature-match confidence. SCANS mode needs the affine matcher.
    if (mode == cv::Stitcher::SCANS) {
      stitcher->setFeaturesMatcher(
          cv::makePtr<cv::detail::AffineBestOf2NearestMatcher>(false, false, matchConf));
    } else {
      stitcher->setFeaturesMatcher(
          cv::makePtr<cv::detail::BestOf2NearestMatcher>(false, matchConf));
    }

    // panoConfidence = pano confidence threshold. After matching, OpenCV keeps
    // only the largest connected component of images clearing this bar
    // (leaveBiggestComponent) — at the default 1.0 it can silently drop
    // weakly-matched images. Must be set before estimateTransform (stitch()).
    stitcher->setPanoConfidenceThresh((double)panoConfidence);

    // matchNeighbors > 0 restricts feature matching to |i-j| <= k (plus the
    // wrap pair when matchWrap). Must be set before stitch().
    cv::UMat matchingMask = buildMatchingMask((int)images.size(), (int)matchNeighbors, matchWrap);
    if (!matchingMask.empty()) {
      stitcher->setMatchingMask(matchingMask);
    }

    // blendStrength 1-10 = number of multiband blending bands.
    int bands = (int)MIN(MAX(blendStrength, 1), 10);
    stitcher->setBlender(cv::makePtr<cv::detail::MultiBandBlender>(false, bands));

    if ([warpMode isEqualToString:@"cylindrical"]) {
      stitcher->setWarper(cv::makePtr<cv::CylindricalWarper>());
    }

    cv::Mat pano;
    cv::Stitcher::Status status = stitcher->stitch(images, pano);
    if (status != cv::Stitcher::OK) {
      return [self resultWithError:[self messageForStatus:status]];
    }

    // Which input images ended up in the composite (ascending input indices).
    // Sorted COPY: computeStitchGeometry needs the unsorted component() order
    // to pair with cameras().
    std::vector<int> component = stitcher->component();
    std::sort(component.begin(), component.end());
    NSMutableArray<NSNumber *> *usedIndices = [NSMutableArray arrayWithCapacity:component.size()];
    for (int idx : component) {
      [usedIndices addObject:@(idx)];
    }

    // Geometry is recovered on the UN-resized composite (selfCheck compares
    // against this size); the output affine is added after the resize below.
    std::string projection =
        (mode == cv::Stitcher::SCANS)
            ? "affine"
            : ([warpMode isEqualToString:@"cylindrical"] ? "cylindrical" : "spherical");
    StitchGeometry geometry = computeStitchGeometry(stitcher, images, projection, pano.size());

    if (autoResize && outputWidth > 0) {
      int targetW = (int)outputWidth;
      int targetH = targetW / 2; // equirectangular 2:1
      cv::resize(pano, pano, cv::Size(targetW, targetH), 0, 0, cv::INTER_AREA);
    } else if (outputWidth > 0 && pano.cols > outputWidth) {
      double scale = (double)outputWidth / pano.cols;
      cv::resize(pano, pano, cv::Size(), scale, scale, cv::INTER_AREA);
    }

    std::string geometryJson = buildGeometryJson(geometry, pano.size());

    std::vector<int> params = { cv::IMWRITE_JPEG_QUALITY, (int)jpegQuality };
    if (!cv::imwrite([outputPath UTF8String], pano, params)) {
      return [self resultWithError:@"Failed to write output JPEG"];
    }

    return @{
      PanoStitchSuccessKey     : @(YES),
      PanoStitchWidthKey       : @(pano.cols),
      PanoStitchHeightKey      : @(pano.rows),
      PanoStitchUsedIndicesKey : usedIndices,
      PanoStitchGeometryKey    : [NSString stringWithUTF8String:geometryJson.c_str()] ?: @"",
      PanoStitchErrorKey       : @"",
    };
  } catch (const cv::Exception &e) {
    return [self resultWithError:[NSString stringWithFormat:@"OpenCV exception: %s", e.what()]];
  } catch (const std::exception &e) {
    return [self resultWithError:[NSString stringWithFormat:@"Native exception: %s", e.what()]];
  } catch (...) {
    return [self resultWithError:@"Unknown native exception during stitching"];
  }
}

@end

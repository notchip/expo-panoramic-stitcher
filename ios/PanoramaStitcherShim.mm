//
//  PanoramaStitcherShim.mm
//  Objective-C++ implementation. Wraps cv::Stitcher.
//
//  The stitch core below must stay logically identical to the Android JNI shim
//  (android/src/main/cpp/panorama_stitcher_jni.cpp). Edit both together.
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
#include <string>
#include <vector>

NSString *const PanoStitchSuccessKey     = @"success";
NSString *const PanoStitchWidthKey       = @"width";
NSString *const PanoStitchHeightKey      = @"height";
NSString *const PanoStitchUsedIndicesKey = @"usedIndices";
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
    std::vector<int> component = stitcher->component();
    std::sort(component.begin(), component.end());
    NSMutableArray<NSNumber *> *usedIndices = [NSMutableArray arrayWithCapacity:component.size()];
    for (int idx : component) {
      [usedIndices addObject:@(idx)];
    }

    if (autoResize && outputWidth > 0) {
      int targetW = (int)outputWidth;
      int targetH = targetW / 2; // equirectangular 2:1
      cv::resize(pano, pano, cv::Size(targetW, targetH), 0, 0, cv::INTER_AREA);
    } else if (outputWidth > 0 && pano.cols > outputWidth) {
      double scale = (double)outputWidth / pano.cols;
      cv::resize(pano, pano, cv::Size(), scale, scale, cv::INTER_AREA);
    }

    std::vector<int> params = { cv::IMWRITE_JPEG_QUALITY, (int)jpegQuality };
    if (!cv::imwrite([outputPath UTF8String], pano, params)) {
      return [self resultWithError:@"Failed to write output JPEG"];
    }

    return @{
      PanoStitchSuccessKey     : @(YES),
      PanoStitchWidthKey       : @(pano.cols),
      PanoStitchHeightKey      : @(pano.rows),
      PanoStitchUsedIndicesKey : usedIndices,
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

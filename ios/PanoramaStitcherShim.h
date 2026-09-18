//
//  PanoramaStitcherShim.h
//  Thin Objective-C façade over OpenCV's C++ Stitcher.
//
//  This is the ONLY non-Swift file in the module. It exists because OpenCV ships
//  a C++ API with no Swift bindings — Swift talks to this plain ObjC interface and
//  never sees a C++ type. All image IO is done by OpenCV (cv::imread / cv::imwrite),
//  so there is no UIKit here and nothing to convert by hand.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Keys present in the returned NSDictionary.
extern NSString *const PanoStitchSuccessKey;      // NSNumber(BOOL)
extern NSString *const PanoStitchWidthKey;        // NSNumber(int)
extern NSString *const PanoStitchHeightKey;       // NSNumber(int)
extern NSString *const PanoStitchUsedIndicesKey;  // NSArray<NSNumber(int)> — input indices actually composited
extern NSString *const PanoStitchGeometryKey;     // NSString — compact JSON (StitchGeometry v1) or "" when unavailable
extern NSString *const PanoStitchErrorKey;        // NSString

@interface PanoramaStitcherShim : NSObject

/// Smoke-test that the OpenCV C++ runtime is linked and callable.
+ (NSString *)helloFromOpenCV:(NSString *)name;

/// OpenCV build/version string (e.g. "4.13.0"). Empty if unavailable.
+ (NSString *)openCVVersion;

/// Stitch the given image files into `outputPath` (JPEG).
/// Reads/writes via OpenCV directly. Returns a dictionary using the keys above.
/// `matchNeighbors` 0 = match all pairs (OpenCV default); k > 0 = only pairs
/// with 0 < |i-j| <= k, plus |i-j| >= n-k when `matchWrap` (ordered sweep ends).
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
                       jpegQuality:(NSInteger)jpegQuality;

@end

NS_ASSUME_NONNULL_END

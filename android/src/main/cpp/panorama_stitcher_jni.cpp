//
// panorama_stitcher_jni.cpp
// JNI shim over cv::Stitcher, compiled against the prefab C++ headers shipped
// inside the Maven org.opencv:opencv AAR (the AAR's Java bindings do not wrap
// the stitching module — it is Python-only upstream — so this shim is the
// minimal native layer).
//
// The stitch core below must stay logically identical to the iOS shim
// (ios/PanoramaStitcherShim.mm). Edit both together.
//

#include <jni.h>

#include <opencv2/opencv.hpp>
#include <opencv2/stitching.hpp>

#include <algorithm>
#include <string>
#include <vector>

namespace {

std::string toStd(JNIEnv *env, jstring s) {
  if (s == nullptr) {
    return "";
  }
  const char *chars = env->GetStringUTFChars(s, nullptr);
  if (chars == nullptr) {
    // OutOfMemoryError is pending; caller must check ExceptionCheck().
    return "";
  }
  std::string out(chars);
  env->ReleaseStringUTFChars(s, chars);
  return out;
}

// Distinct, actionable message per cv::Stitcher::Status. Text must stay
// identical to the iOS shim so consumers can match by substring.
std::string messageForStatus(cv::Stitcher::Status status) {
  switch (status) {
    case cv::Stitcher::ERR_NEED_MORE_IMGS:
      return "Not enough matched images to build a panorama (ERR_NEED_MORE_IMGS). "
             "Ensure 30-40% overlap between adjacent images, or lower panoConfidence.";
    case cv::Stitcher::ERR_HOMOGRAPHY_EST_FAIL:
      return "Homography estimation failed (ERR_HOMOGRAPHY_EST_FAIL). warpMode 'plane' "
             "assumes a flat/translational scene - use 'spherical' or 'cylindrical' for "
             "rotational captures.";
    case cv::Stitcher::ERR_CAMERA_PARAMS_ADJUST_FAIL:
      return "Camera parameter adjustment failed (ERR_CAMERA_PARAMS_ADJUST_FAIL). Images "
             "may have too little overlap or too few matched features.";
    default:
      return "OpenCV stitch failed (status " + std::to_string((int)status) + ").";
  }
}

// Returns "ok|<width>|<height>|<idx,idx,...>" on success (the comma-joined
// ascending input indices OpenCV actually composited), "err|<message>" on
// failure.
std::string stitchCore(const std::vector<std::string> &imagePaths,
                       const std::string &outputPath,
                       const std::string &warpMode,
                       int blendStrength,
                       float matchConf,
                       float panoConfidence,
                       int outputWidth,
                       bool autoResize,
                       int jpegQuality) {
  try {
    if (imagePaths.size() < 2) {
      return "err|At least 2 images are required";
    }

    std::vector<cv::Mat> images;
    images.reserve(imagePaths.size());
    for (const std::string &path : imagePaths) {
      cv::Mat img = cv::imread(path, cv::IMREAD_COLOR);
      if (img.empty()) {
        return "err|Failed to read image: " + path;
      }
      images.push_back(img);
    }

    // PANORAMA == spherical/cylindrical projective stitching; SCANS == affine,
    // best for flat/plane scans.
    cv::Stitcher::Mode mode =
        (warpMode == "plane") ? cv::Stitcher::SCANS : cv::Stitcher::PANORAMA;
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
    int bands = std::min(std::max(blendStrength, 1), 10);
    stitcher->setBlender(cv::makePtr<cv::detail::MultiBandBlender>(false, bands));

    if (warpMode == "cylindrical") {
      stitcher->setWarper(cv::makePtr<cv::CylindricalWarper>());
    }

    cv::Mat pano;
    cv::Stitcher::Status status = stitcher->stitch(images, pano);
    if (status != cv::Stitcher::OK) {
      return "err|" + messageForStatus(status);
    }

    // Which input images ended up in the composite (ascending input indices).
    std::vector<int> component = stitcher->component();
    std::sort(component.begin(), component.end());
    std::string usedIndices;
    for (size_t i = 0; i < component.size(); i++) {
      if (i > 0) {
        usedIndices += ",";
      }
      usedIndices += std::to_string(component[i]);
    }

    if (autoResize && outputWidth > 0) {
      int targetW = outputWidth;
      int targetH = targetW / 2;  // equirectangular 2:1
      cv::resize(pano, pano, cv::Size(targetW, targetH), 0, 0, cv::INTER_AREA);
    } else if (outputWidth > 0 && pano.cols > outputWidth) {
      double scale = (double)outputWidth / pano.cols;
      cv::resize(pano, pano, cv::Size(), scale, scale, cv::INTER_AREA);
    }

    std::vector<int> params = {cv::IMWRITE_JPEG_QUALITY, jpegQuality};
    if (!cv::imwrite(outputPath, pano, params)) {
      return "err|Failed to write output JPEG";
    }

    return "ok|" + std::to_string(pano.cols) + "|" + std::to_string(pano.rows) +
           "|" + usedIndices;
  } catch (const cv::Exception &e) {
    return std::string("err|OpenCV exception: ") + e.what();
  } catch (const std::exception &e) {
    return std::string("err|Native exception: ") + e.what();
  } catch (...) {
    return "err|Unknown native exception during stitching";
  }
}

}  // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_expo_modules_panoramicstitcher_PanoramaStitcherNative_nativeVersion(
    JNIEnv *env, jobject /*thiz*/) {
  return env->NewStringUTF(cv::getVersionString().c_str());
}

extern "C" JNIEXPORT jstring JNICALL
Java_expo_modules_panoramicstitcher_PanoramaStitcherNative_nativeStitch(
    JNIEnv *env, jobject /*thiz*/, jobjectArray imagePaths, jstring outputPath,
    jstring warpMode, jint blendStrength, jfloat matchConf, jfloat panoConfidence,
    jint outputWidth, jboolean autoResize, jint jpegQuality) {
  // The whole wrapper is guarded too — a C++ exception escaping a JNI entry
  // point would call std::terminate.
  try {
    std::vector<std::string> paths;
    jsize count = env->GetArrayLength(imagePaths);
    paths.reserve((size_t)count);
    for (jsize i = 0; i < count; i++) {
      auto jpath = (jstring)env->GetObjectArrayElement(imagePaths, i);
      paths.push_back(toStd(env, jpath));
      env->DeleteLocalRef(jpath);
    }
    if (env->ExceptionCheck()) {
      return nullptr;  // propagate the pending Java exception
    }

    std::string result = stitchCore(paths, toStd(env, outputPath), toStd(env, warpMode),
                                    (int)blendStrength, (float)matchConf, (float)panoConfidence,
                                    (int)outputWidth, autoResize == JNI_TRUE, (int)jpegQuality);
    return env->NewStringUTF(result.c_str());
  } catch (const std::exception &e) {
    std::string msg = std::string("err|Native exception: ") + e.what();
    return env->NewStringUTF(msg.c_str());
  } catch (...) {
    return env->NewStringUTF("err|Unknown native exception during stitching");
  }
}

# Builds the JNI stitching shim against the official OpenCV Android SDK's
# static libraries. The Maven org.opencv:opencv AAR does NOT compile the
# stitching module into libopencv_java4.so (cv::Stitcher & friends are
# undefined there), so the SDK zip is downloaded/unpacked by a Gradle task in
# android/build.gradle, which passes its location in via -DOPENCV_ANDROID_SDK.
cmake_minimum_required(VERSION 3.22.1)
project(panostitcher CXX)

# ---------------------------------------------------------------------------
# Locate the unpacked OpenCV Android SDK (required).
# ---------------------------------------------------------------------------
set(OPENCV_ANDROID_SDK "" CACHE PATH "Path to the unpacked OpenCV Android SDK (the directory containing sdk/native)")

if(NOT OPENCV_ANDROID_SDK)
  message(FATAL_ERROR
    "OPENCV_ANDROID_SDK is not set. It must point at the unpacked OpenCV "
    "Android SDK (the directory containing sdk/native/jni/include). The "
    "downloadOpenCVAndroidSdk Gradle task in android/build.gradle normally "
    "downloads it and passes -DOPENCV_ANDROID_SDK automatically.")
endif()

set(OPENCV_INCLUDE_DIR "${OPENCV_ANDROID_SDK}/sdk/native/jni/include")
if(NOT EXISTS "${OPENCV_INCLUDE_DIR}/opencv2/opencv.hpp")
  message(FATAL_ERROR
    "OPENCV_ANDROID_SDK='${OPENCV_ANDROID_SDK}' does not look like an "
    "unpacked OpenCV Android SDK: missing "
    "'${OPENCV_INCLUDE_DIR}/opencv2/opencv.hpp'. Delete the cache directory "
    "and re-run the build so the downloadOpenCVAndroidSdk task re-downloads it.")
endif()

set(OPENCV_STATICLIBS_DIR "${OPENCV_ANDROID_SDK}/sdk/native/staticlibs/${ANDROID_ABI}")
if(NOT IS_DIRECTORY "${OPENCV_STATICLIBS_DIR}")
  message(FATAL_ERROR
    "The OpenCV Android SDK at '${OPENCV_ANDROID_SDK}' has no static "
    "libraries for ABI '${ANDROID_ABI}' (missing '${OPENCV_STATICLIBS_DIR}'). "
    "This ABI cannot be built — do not silently drop it; either restrict the "
    "app's abiFilters to the ABIs the SDK ships or use an OpenCV SDK build "
    "that includes '${ANDROID_ABI}'.")
endif()

set(OPENCV_3RDPARTY_DIR "${OPENCV_ANDROID_SDK}/sdk/native/3rdparty/libs/${ANDROID_ABI}")
if(NOT IS_DIRECTORY "${OPENCV_3RDPARTY_DIR}")
  message(FATAL_ERROR
    "The OpenCV Android SDK at '${OPENCV_ANDROID_SDK}' has no 3rdparty "
    "libraries for ABI '${ANDROID_ABI}' (missing '${OPENCV_3RDPARTY_DIR}').")
endif()

# ---------------------------------------------------------------------------
# OpenCV module archives the shim needs, most-dependent first:
# stitching -> calib3d -> features2d -> flann, plus imgcodecs (imread/imwrite)
# -> imgproc -> core. (--start-group below makes the order non-load-bearing,
# but keep it correct anyway.)
# ---------------------------------------------------------------------------
set(OPENCV_MODULE_LIBS "")
foreach(module stitching calib3d features2d flann imgcodecs imgproc core)
  set(lib "${OPENCV_STATICLIBS_DIR}/libopencv_${module}.a")
  if(NOT EXISTS "${lib}")
    message(FATAL_ERROR
      "Missing OpenCV static library for ABI '${ANDROID_ABI}': '${lib}'.")
  endif()
  list(APPEND OPENCV_MODULE_LIBS "${lib}")
endforeach()

# All bundled 3rdparty archives for this ABI (image codecs, HAL, etc.). The
# set differs per ABI — e.g. tegra_hal/kleidicv exist only on ARM — so glob
# instead of hardcoding; unused archives contribute nothing to a static link.
# Note: the SDK bundles no zlib archive; libpng/libtiff get zlib from the
# NDK's system libz (linked below).
file(GLOB OPENCV_3RDPARTY_LIBS "${OPENCV_3RDPARTY_DIR}/*.a")
if(NOT OPENCV_3RDPARTY_LIBS)
  message(FATAL_ERROR
    "No 3rdparty static libraries found in '${OPENCV_3RDPARTY_DIR}' — the "
    "unpacked OpenCV Android SDK looks incomplete. Delete the cache "
    "directory and re-run the build to re-download it.")
endif()

# ---------------------------------------------------------------------------
# The shim itself.
# ---------------------------------------------------------------------------
add_library(panostitcher SHARED src/main/cpp/panorama_stitcher_jni.cpp)

set_target_properties(panostitcher PROPERTIES
  CXX_STANDARD 17
  CXX_STANDARD_REQUIRED ON
)
target_compile_options(panostitcher PRIVATE -fexceptions -frtti)
target_include_directories(panostitcher SYSTEM PRIVATE "${OPENCV_INCLUDE_DIR}")

# 16KB page alignment: required for Google Play targetSdk 35+ / 16KB-page
# devices. (Recent AGP/NDK default to this, but be explicit.)
target_link_options(panostitcher PRIVATE "-Wl,-z,max-page-size=16384")

# Wrap every OpenCV + 3rdparty archive in one --start-group/--end-group so
# archive order never matters. System libs, per an nm closure check over the
# 4.13.0 archives on all four ABIs: log (__android_log_print), z (crc32/
# deflate/gz* — the SDK bundles no zlib archive; libpng/libtiff use the NDK's
# system libz), dl (dlopen/dlsym from ittnotify/OpenCL loader). Nothing in
# the closure references libandroid or libjnigraphics, so they are not linked.
# libc/libm/libc++_shared/compiler-rt cover the rest via the NDK defaults.
target_link_libraries(panostitcher
  -Wl,--start-group
  ${OPENCV_MODULE_LIBS}
  ${OPENCV_3RDPARTY_LIBS}
  -Wl,--end-group
  log
  z
  dl
)

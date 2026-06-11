# Builds the JNI stitching shim against the prefab OpenCV package exported by
# the Maven org.opencv:opencv AAR (prefab package "OpenCV", module "opencv_java4").
cmake_minimum_required(VERSION 3.22.1)
project(panostitcher CXX)

find_package(OpenCV REQUIRED CONFIG)

add_library(panostitcher SHARED src/main/cpp/panorama_stitcher_jni.cpp)

set_target_properties(panostitcher PROPERTIES
  CXX_STANDARD 17
  CXX_STANDARD_REQUIRED ON
)
target_compile_options(panostitcher PRIVATE -fexceptions -frtti)

find_library(log-lib log)
target_link_libraries(panostitcher OpenCV::opencv_java4 ${log-lib})

package expo.modules.panoramicstitcher

import android.graphics.BitmapFactory
import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

class StitchException(message: String) : CodedException(message)

/** JNI surface for the C++ stitch shim (src/main/cpp/panorama_stitcher_jni.cpp). */
private object PanoramaStitcherNative {
  init {
    System.loadLibrary("panostitcher")
  }

  external fun nativeVersion(): String

  external fun nativeStitch(
    imagePaths: Array<String>,
    outputPath: String,
    warpMode: String,
    blendStrength: Int,
    matchConf: Float,
    outputWidth: Int,
    autoResize: Boolean,
    jpegQuality: Int
  ): String
}

/**
 * Panorama stitcher. OpenCV comes from Maven Central (org.opencv:opencv) — native
 * .so libs bundled automatically, no manual SDK download. The AAR has no Java
 * bindings for the stitching module, so stitching runs through one small JNI shim
 * compiled against the AAR's prefab C++ headers (mirrors the iOS ObjC++ shim).
 */
class ExpoPanoramicStitcherModule : Module() {

  // Touching PanoramaStitcherNative triggers System.loadLibrary; libopencv_java4.so
  // loads automatically as a DT_NEEDED dependency.
  private val nativeReady: Boolean by lazy {
    runCatching { PanoramaStitcherNative.nativeVersion() }.isSuccess
  }

  // Dedicated thread so multi-second OpenCV work never blocks the process-wide
  // AsyncFunctionQueue shared by every Expo module.
  private val stitchExecutor = Executors.newSingleThreadExecutor { r ->
    Thread(r, "expo.panoramicstitcher.stitch")
  }

  override fun definition() = ModuleDefinition {
    Name("ExpoPanoramicStitcher")

    Events("onStitchProgress")

    Function("isAvailable") { nativeReady }

    Function("helloFromNative") { name: String ->
      if (nativeReady) "Hello $name, OpenCV ${PanoramaStitcherNative.nativeVersion()} is linked ✅"
      else "Hello $name (OpenCV failed to load)"
    }

    AsyncFunction("stitchImagePaths") { imagePaths: List<String>, options: Map<String, Any?>, promise: Promise ->
      runOnStitchThread(promise) {
        emitProgress(0.3, "stitching")
        val result = stitchToFile(imagePaths, StitchOptions.from(options))
        emitProgress(1.0, "done")
        result
      }
    }

    AsyncFunction("stitchBase64") { images: List<String>, options: Map<String, Any?>, promise: Promise ->
      runOnStitchThread(promise) {
        stitchBase64Inputs(images, StitchOptions.from(options))
      }
    }

    AsyncFunction("stitchIncrementalBase64") {
      existingPanorama: String?, newImage: String, options: Map<String, Any?>, promise: Promise ->
      runOnStitchThread(promise) {
        if (existingPanorama.isNullOrEmpty()) {
          // First frame: nothing to stitch yet — the image itself is the seed panorama.
          firstFrameResult(newImage)
        } else {
          stitchBase64Inputs(listOf(existingPanorama, newImage), StitchOptions.from(options))
        }
      }
    }

    OnDestroy {
      stitchExecutor.shutdown()
    }
  }

  // MARK: - Core

  private fun runOnStitchThread(promise: Promise, block: () -> Map<String, Any>) {
    stitchExecutor.execute {
      try {
        promise.resolve(block())
      } catch (e: CodedException) {
        promise.reject(e)
      } catch (e: Throwable) {
        promise.reject(StitchException(e.message ?: "Unknown native error"))
      }
    }
  }

  private fun emitProgress(progress: Double, stage: String) {
    sendEvent("onStitchProgress", mapOf("progress" to progress, "stage" to stage))
  }

  private fun stitchBase64Inputs(images: List<String>, opts: StitchOptions): Map<String, Any> {
    emitProgress(0.1, "decoding")
    val paths = writeTempImages(images)
    try {
      emitProgress(0.3, "stitching")
      val result = stitchToFile(paths, opts)
      emitProgress(0.85, "encoding")
      val encoded = fileToBase64(result)
      emitProgress(1.0, "done")
      return encoded
    } finally {
      cleanup(paths)
    }
  }

  private fun stitchToFile(imagePaths: List<String>, opts: StitchOptions): Map<String, Any> {
    if (!nativeReady) throw StitchException("OpenCV is not available on this device")
    if (imagePaths.size < 2) throw StitchException("At least 2 images are required")

    val outPath = File(tempDir(), "panorama_${UUID.randomUUID()}.jpg").absolutePath
    val raw = PanoramaStitcherNative.nativeStitch(
      imagePaths.toTypedArray(),
      outPath,
      opts.warpMode,
      opts.blendStrength,
      opts.matchConf,
      opts.outputWidth,
      opts.autoResize,
      opts.jpegQuality
    )

    // Shim protocol: "ok|<width>|<height>" or "err|<message>".
    if (!raw.startsWith("ok|")) {
      throw StitchException(raw.removePrefix("err|"))
    }
    val parts = raw.split("|")
    val width = parts[1].toInt()
    val height = parts[2].toInt()

    return mapOf(
      "success" to true,
      "path" to outPath,
      "width" to width,
      "height" to height,
      "aspectRatio" to if (height > 0) width.toDouble() / height else 0.0,
      "errorMessage" to ""
    )
  }

  private fun fileToBase64(result: Map<String, Any>): Map<String, Any> {
    val file = File(result["path"] as String)
    return try {
      val bytes = try {
        file.readBytes()
      } catch (e: Exception) {
        // Same message as iOS for the same failure.
        throw StitchException("Could not read stitched output")
      }
      mapOf(
        "success" to true,
        "base64Image" to Base64.encodeToString(bytes, Base64.NO_WRAP),
        "width" to (result["width"] ?: 0),
        "height" to (result["height"] ?: 0),
        "errorMessage" to ""
      )
    } finally {
      runCatching { file.delete() }
    }
  }

  /** First incremental frame: validate + measure, return it unchanged as the panorama. */
  private fun firstFrameResult(newImage: String): Map<String, Any> {
    val clean = stripDataUrl(newImage)
    val bytes = decodeBase64(clean, index = 0)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
      throw StitchException("Could not decode first image")
    }
    return mapOf(
      "success" to true,
      "base64Image" to clean,
      "width" to bounds.outWidth,
      "height" to bounds.outHeight,
      "errorMessage" to ""
    )
  }

  // MARK: - Helpers

  private fun tempDir(): File {
    // appContext.cacheDirectory is non-null (unlike reactContext?.cacheDir).
    val dir = File(appContext.cacheDirectory, "pano-stitch")
    if (!dir.exists()) dir.mkdirs()
    return dir
  }

  private fun stripDataUrl(base64: String): String =
    if (base64.contains(",")) base64.substringAfter(",") else base64

  private fun decodeBase64(clean: String, index: Int): ByteArray = try {
    Base64.decode(clean, Base64.DEFAULT)
  } catch (e: IllegalArgumentException) {
    throw StitchException("Invalid base64 at index $index")
  }

  /**
   * Decode base64 JPEGs (data-URL prefix tolerated) to temp files; returns paths.
   * Cleans up already-written files if a later input fails to decode.
   */
  private fun writeTempImages(base64Images: List<String>): List<String> {
    val paths = mutableListOf<String>()
    try {
      base64Images.forEachIndexed { i, raw ->
        val bytes = decodeBase64(stripDataUrl(raw), index = i)
        val file = File(tempDir(), "in_${UUID.randomUUID()}.jpg")
        try {
          file.writeBytes(bytes)
        } catch (e: Exception) {
          // Keep the error coded and identical to iOS's.
          throw StitchException("Failed to write temp image at index $i")
        }
        paths.add(file.absolutePath)
      }
    } catch (t: Throwable) {
      cleanup(paths)
      throw t
    }
    return paths
  }

  private fun cleanup(paths: List<String>) {
    paths.forEach { runCatching { File(it).delete() } }
  }
}

private data class StitchOptions(
  val warpMode: String,
  val blendStrength: Int,
  val matchConf: Float,
  val outputWidth: Int,
  val autoResize: Boolean,
  val jpegQuality: Int
) {
  companion object {
    fun from(map: Map<String, Any?>) = StitchOptions(
      warpMode = map["warpMode"] as? String ?: "spherical",
      blendStrength = (map["blendStrength"] as? Number)?.toInt() ?: 5,
      matchConf = (map["matchConf"] as? Number)?.toFloat() ?: 0.3f,
      outputWidth = (map["outputWidth"] as? Number)?.toInt() ?: 4096,
      autoResize = map["autoResize"] as? Boolean ?: true,
      jpegQuality = (map["jpegQuality"] as? Number)?.toInt() ?: 95
    )
  }
}

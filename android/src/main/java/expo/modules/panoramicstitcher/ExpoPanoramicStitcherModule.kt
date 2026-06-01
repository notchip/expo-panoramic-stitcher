package expo.modules.panoramicstitcher

import android.util.Base64
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.exception.CodedException
import org.opencv.android.OpenCVLoader
import org.opencv.core.Mat
import org.opencv.core.MatOfInt
import org.opencv.core.Size
import org.opencv.imgcodecs.Imgcodecs
import org.opencv.imgproc.Imgproc
import org.opencv.stitching.Stitcher
import java.io.File
import java.util.UUID

private const val TAG = "ExpoPanoramicStitcher"

class StitchException(message: String) : CodedException(message)

/**
 * Pure-Kotlin panorama stitcher. OpenCV is pulled from Maven Central
 * (org.opencv:opencv) which ships a Java/Kotlin API plus bundled native libs —
 * so there is NO JNI, NO CMake and NO manual OpenCV SDK in this module.
 */
class ExpoPanoramicStitcherModule : Module() {

  private val openCvReady: Boolean by lazy {
    val ok = OpenCVLoader.initLocal()
    if (!ok) Log.e(TAG, "OpenCVLoader.initLocal() failed")
    ok
  }

  override fun definition() = ModuleDefinition {
    Name("ExpoPanoramicStitcher")

    Events("onStitchProgress")

    Function("isAvailable") { openCvReady }

    Function("helloFromNative") { name: String ->
      if (openCvReady) "Hello $name, OpenCV ${org.opencv.core.Core.VERSION} is linked ✅"
      else "Hello $name (OpenCV failed to load)"
    }

    AsyncFunction("stitchImagePaths") { imagePaths: List<String>, options: Map<String, Any?> ->
      stitchToFile(imagePaths, StitchOptions.from(options))
    }

    AsyncFunction("stitchBase64") { images: List<String>, options: Map<String, Any?> ->
      val opts = StitchOptions.from(options)
      val paths = images.map { writeTempImage(it) }
      try {
        val result = stitchToFile(paths, opts)
        fileToBase64(result)
      } finally {
        paths.forEach { runCatching { File(it).delete() } }
      }
    }

    AsyncFunction("stitchIncrementalBase64") {
      existingPanorama: String?, newImage: String, options: Map<String, Any?> ->
      val opts = StitchOptions.from(options)
      val inputs = buildList {
        if (!existingPanorama.isNullOrEmpty()) add(existingPanorama)
        add(newImage)
      }
      val paths = inputs.map { writeTempImage(it) }
      try {
        val result = stitchToFile(paths, opts)
        fileToBase64(result)
      } finally {
        paths.forEach { runCatching { File(it).delete() } }
      }
    }
  }

  // MARK: - Core

  private fun stitchToFile(imagePaths: List<String>, opts: StitchOptions): Map<String, Any> {
    if (!openCvReady) throw StitchException("OpenCV is not available on this device")
    if (imagePaths.size < 2) throw StitchException("At least 2 images are required")

    val images = ArrayList<Mat>(imagePaths.size)
    try {
      for (path in imagePaths) {
        val mat = Imgcodecs.imread(path, Imgcodecs.IMREAD_COLOR)
        if (mat.empty()) throw StitchException("Failed to read image: $path")
        images.add(mat)
      }

      val mode = if (opts.warpMode == "plane") Stitcher.SCANS else Stitcher.PANORAMA
      val stitcher = Stitcher.create(mode)
      stitcher.setPanoConfidenceThresh(opts.matchConf.toDouble())

      val pano = Mat()
      val status = stitcher.stitch(images, pano)
      if (status != Stitcher.OK) {
        pano.release()
        throw StitchException(
          "OpenCV stitch failed (status $status). Ensure 30-40% overlap between images."
        )
      }

      if (opts.autoResize && opts.outputWidth > 0) {
        val targetW = opts.outputWidth
        val targetH = targetW / 2 // equirectangular 2:1
        Imgproc.resize(pano, pano, Size(targetW.toDouble(), targetH.toDouble()), 0.0, 0.0, Imgproc.INTER_AREA)
      } else if (opts.outputWidth > 0 && pano.cols() > opts.outputWidth) {
        val scale = opts.outputWidth.toDouble() / pano.cols()
        Imgproc.resize(pano, pano, Size(), scale, scale, Imgproc.INTER_AREA)
      }

      val outPath = File(tempDir(), "panorama_${UUID.randomUUID()}.jpg").absolutePath
      val params = MatOfInt(Imgcodecs.IMWRITE_JPEG_QUALITY, opts.jpegQuality)
      val wrote = Imgcodecs.imwrite(outPath, pano, params)
      val width = pano.cols()
      val height = pano.rows()
      pano.release()
      if (!wrote) throw StitchException("Failed to write output JPEG")

      return mapOf(
        "success" to true,
        "path" to outPath,
        "width" to width,
        "height" to height,
        "aspectRatio" to if (height > 0) width.toDouble() / height else 0.0,
        "errorMessage" to ""
      )
    } finally {
      images.forEach { it.release() }
    }
  }

  private fun fileToBase64(result: Map<String, Any>): Map<String, Any> {
    val path = result["path"] as String
    val file = File(path)
    return try {
      val bytes = file.readBytes()
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

  // MARK: - Helpers

  private fun tempDir(): File {
    val dir = File(appContext.reactContext?.cacheDir, "pano-stitch")
    if (!dir.exists()) dir.mkdirs()
    return dir
  }

  /** Decode a base64 JPEG (data-URL prefix tolerated) to a temp file; returns its path. */
  private fun writeTempImage(base64: String): String {
    val clean = if (base64.contains(",")) base64.substringAfter(",") else base64
    val bytes = Base64.decode(clean, Base64.DEFAULT)
    val file = File(tempDir(), "in_${UUID.randomUUID()}.jpg")
    file.writeBytes(bytes)
    return file.absolutePath
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

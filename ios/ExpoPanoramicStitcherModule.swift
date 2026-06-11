import CoreGraphics
import ExpoModulesCore
import Foundation
import ImageIO

// PanoramaStitcherShim (Objective-C++) is exposed to Swift through the pod's
// auto-generated umbrella header — no manual bridging header required.

public class ExpoPanoramicStitcherModule: Module {
  // Dedicated serial queue so multi-second OpenCV work never blocks the
  // process-wide queue shared by every Expo module's AsyncFunctions.
  private static let stitchQueue = DispatchQueue(label: "expo.panoramicstitcher.stitch", qos: .userInitiated)

  public func definition() -> ModuleDefinition {
    Name("ExpoPanoramicStitcher")

    Events("onStitchProgress")

    Function("isAvailable") { () -> Bool in
      return !PanoramaStitcherShim.openCVVersion().isEmpty
    }

    Function("helloFromNative") { (name: String) -> String in
      return PanoramaStitcherShim.hello(fromOpenCV: name)
    }

    AsyncFunction("stitchImagePaths") { (imagePaths: [String], options: StitchOptions) -> StitchResult in
      self.progress(0.3, "stitching")
      let out = try Self.stitchPaths(imagePaths, options: options)
      self.progress(1.0, "done")
      return out
    }.runOnQueue(Self.stitchQueue)

    AsyncFunction("stitchBase64") { (images: [String], options: StitchOptions) -> StitchBase64Result in
      return try self.stitchBase64Inputs(images, options: options)
    }.runOnQueue(Self.stitchQueue)

    AsyncFunction("stitchIncrementalBase64") {
      (existingPanorama: String?, newImage: String, options: StitchOptions) -> StitchBase64Result in
      guard let existing = existingPanorama, !existing.isEmpty else {
        // First frame: nothing to stitch yet — the image itself is the seed panorama.
        return try Self.firstFrameResult(newImage)
      }
      return try self.stitchBase64Inputs([existing, newImage], options: options)
    }.runOnQueue(Self.stitchQueue)
  }

  // MARK: - Core

  private func progress(_ value: Double, _ stage: String) {
    sendEvent("onStitchProgress", ["progress": value, "stage": stage])
  }

  private func stitchBase64Inputs(_ images: [String], options: StitchOptions) throws -> StitchBase64Result {
    progress(0.1, "decoding")
    let paths = try Self.writeTempImages(images)
    defer { Self.cleanup(paths) }
    progress(0.3, "stitching")
    let out = try Self.stitchPaths(paths, options: options)
    progress(0.85, "encoding")
    let result = try Self.toBase64(out)
    progress(1.0, "done")
    return result
  }

  private static func stitchPaths(_ imagePaths: [String], options: StitchOptions) throws -> StitchResult {
    let outputURL = tempDir().appendingPathComponent("panorama_\(UUID().uuidString).jpg")

    let dict = PanoramaStitcherShim.stitchImagePaths(
      imagePaths,
      outputPath: outputURL.path,
      warpMode: options.warpMode,
      blendStrength: options.blendStrength,
      matchConf: options.matchConf,
      outputWidth: options.outputWidth,
      autoResize: options.autoResize,
      jpegQuality: options.jpegQuality
    )

    let success = (dict[PanoStitchSuccessKey] as? Bool) ?? false
    let width = (dict[PanoStitchWidthKey] as? Int) ?? 0
    let height = (dict[PanoStitchHeightKey] as? Int) ?? 0
    let error = (dict[PanoStitchErrorKey] as? String) ?? ""

    if !success {
      throw Exception(name: "StitchError", description: error.isEmpty ? "Stitching failed" : error)
    }

    return StitchResult(
      success: true,
      path: outputURL.path,
      width: width,
      height: height,
      aspectRatio: height > 0 ? Double(width) / Double(height) : 0,
      errorMessage: ""
    )
  }

  private static func toBase64(_ result: StitchResult) throws -> StitchBase64Result {
    let url = URL(fileURLWithPath: result.path)
    defer { try? FileManager.default.removeItem(at: url) }
    guard let data = try? Data(contentsOf: url) else {
      throw Exception(name: "StitchError", description: "Could not read stitched output")
    }
    return StitchBase64Result(
      success: true,
      base64Image: data.base64EncodedString(),
      width: result.width,
      height: result.height,
      errorMessage: ""
    )
  }

  /// First incremental frame: validate + measure, return it unchanged as the panorama.
  private static func firstFrameResult(_ newImage: String) throws -> StitchBase64Result {
    let clean = stripDataUrl(newImage)
    guard let data = Data(base64Encoded: clean, options: .ignoreUnknownCharacters) else {
      throw Exception(name: "StitchError", description: "Invalid base64 at index 0")
    }
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = props[kCGImagePropertyPixelWidth] as? Int,
      let height = props[kCGImagePropertyPixelHeight] as? Int,
      width > 0, height > 0
    else {
      throw Exception(name: "StitchError", description: "Could not decode first image")
    }
    return StitchBase64Result(
      success: true,
      base64Image: clean,
      width: width,
      height: height,
      errorMessage: ""
    )
  }

  // MARK: - Helpers

  private static func tempDir() -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pano-stitch", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  // Everything after the FIRST comma (possibly empty) — must match Kotlin's
  // substringAfter(",") so malformed data-URLs fail identically on both platforms.
  private static func stripDataUrl(_ base64: String) -> String {
    guard let comma = base64.firstIndex(of: ",") else {
      return base64
    }
    return String(base64[base64.index(after: comma)...])
  }

  /// Decode base64 JPEGs (data-URL prefix tolerated) to temp files; returns paths.
  /// Cleans up already-written files if a later input fails to decode.
  private static func writeTempImages(_ base64Images: [String]) throws -> [String] {
    var paths: [String] = []
    do {
      for (i, raw) in base64Images.enumerated() {
        let clean = stripDataUrl(raw)
        guard let data = Data(base64Encoded: clean, options: .ignoreUnknownCharacters) else {
          throw Exception(name: "StitchError", description: "Invalid base64 at index \(i)")
        }
        let url = tempDir().appendingPathComponent("in_\(UUID().uuidString).jpg")
        do {
          try data.write(to: url)
        } catch {
          // Keep the error coded (ERR_STITCH) and identical to Android's.
          throw Exception(name: "StitchError", description: "Failed to write temp image at index \(i)")
        }
        paths.append(url.path)
      }
    } catch {
      cleanup(paths)
      throw error
    }
    return paths
  }

  private static func cleanup(_ paths: [String]) {
    for p in paths { try? FileManager.default.removeItem(atPath: p) }
  }
}

// MARK: - Records

struct StitchOptions: Record {
  @Field var warpMode: String = "spherical"
  @Field var blendStrength: Int = 5
  @Field var matchConf: Float = 0.3
  @Field var outputWidth: Int = 4096
  @Field var autoResize: Bool = true
  @Field var jpegQuality: Int = 95
}

struct StitchResult: Record {
  @Field var success: Bool = false
  @Field var path: String = ""
  @Field var width: Int = 0
  @Field var height: Int = 0
  @Field var aspectRatio: Double = 0
  @Field var errorMessage: String = ""
}

struct StitchBase64Result: Record {
  @Field var success: Bool = false
  @Field var base64Image: String = ""
  @Field var width: Int = 0
  @Field var height: Int = 0
  @Field var errorMessage: String = ""
}

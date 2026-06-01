import ExpoModulesCore
import Foundation

// PanoramaStitcherShim (Objective-C++) is exposed to Swift through the pod's
// auto-generated umbrella header — no manual bridging header required.

public class ExpoPanoramicStitcherModule: Module {
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
      return try Self.stitchPaths(imagePaths, options: options)
    }

    AsyncFunction("stitchBase64") { (images: [String], options: StitchOptions) -> StitchBase64Result in
      let paths = try Self.writeTempImages(images)
      defer { Self.cleanup(paths) }
      let out = try Self.stitchPaths(paths, options: options)
      return try Self.toBase64(out, options: options)
    }

    AsyncFunction("stitchIncrementalBase64") {
      (existingPanorama: String?, newImage: String, options: StitchOptions) -> StitchBase64Result in
      var inputs: [String] = []
      if let existing = existingPanorama, !existing.isEmpty { inputs.append(existing) }
      inputs.append(newImage)
      let paths = try Self.writeTempImages(inputs)
      defer { Self.cleanup(paths) }
      let out = try Self.stitchPaths(paths, options: options)
      return try Self.toBase64(out, options: options)
    }
  }

  // MARK: - Core

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

  private static func toBase64(_ result: StitchResult, options: StitchOptions) throws -> StitchBase64Result {
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

  // MARK: - Helpers

  private static func tempDir() -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pano-stitch", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  /// Decode base64 JPEGs (data-URL prefix tolerated) to temp files; returns paths.
  private static func writeTempImages(_ base64Images: [String]) throws -> [String] {
    var paths: [String] = []
    for (i, raw) in base64Images.enumerated() {
      let clean = raw.contains(",") ? String(raw.split(separator: ",").last ?? "") : raw
      guard let data = Data(base64Encoded: clean, options: .ignoreUnknownCharacters) else {
        throw Exception(name: "StitchError", description: "Invalid base64 at index \(i)")
      }
      let url = tempDir().appendingPathComponent("in_\(UUID().uuidString).jpg")
      try data.write(to: url)
      paths.append(url.path)
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

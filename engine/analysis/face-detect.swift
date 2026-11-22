// engine/analysis/face-detect.swift — every face (and text box) per frame, via Apple Vision.
//
// Extends the live scripts/lib/content-sync/vision-frames.swift (2026-09-25), which only reported the
// largest face's centre. The short-form editor needs every face box with confidence, so it can tell
// one speaker from two, keep captions off the face, and verify the rendered crop.
//
//   swift face-detect.swift f00001.jpg f00002.jpg …        (or the compiled binary, same args)
//
// One JSON line per frame. Boxes are normalised 0–1 with a TOP-LEFT origin (Vision's own origin is
// bottom-left; it is flipped here so every consumer uses image coordinates).
//   {"file":"…","w":640,"h":360,"faces":[{"x":…,"y":…,"w":…,"h":…,"c":0.99}],"text":[{"x":…,"y":…,"w":…,"h":…}]}
import Foundation
import Vision
import AppKit

func box(_ r: CGRect) -> String {
  return String(format: "{\"x\":%.4f,\"y\":%.4f,\"w\":%.4f,\"h\":%.4f", r.minX, 1.0 - r.maxY, r.width, r.height)
}

for path in CommandLine.arguments.dropFirst() {
  let file = path.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
  guard let img = NSImage(contentsOfFile: path),
        let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("{\"file\":\"\(file)\",\"error\":\"unreadable\"}")
    continue
  }
  let faceReq = VNDetectFaceRectanglesRequest()
  let textReq = VNDetectTextRectanglesRequest()
  do {
    try VNImageRequestHandler(cgImage: cg, options: [:]).perform([faceReq, textReq])
  } catch {
    print("{\"file\":\"\(file)\",\"error\":\"vision failed\"}")
    continue
  }
  let faces = (faceReq.results ?? []).map { box($0.boundingBox) + String(format: ",\"c\":%.3f}", $0.confidence) }
  let texts = (textReq.results ?? []).map { box($0.boundingBox) + "}" }
  print("{\"file\":\"\(file)\",\"w\":\(cg.width),\"h\":\(cg.height),\"faces\":[\(faces.joined(separator: ","))],\"text\":[\(texts.joined(separator: ","))]}")
}

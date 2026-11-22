// engine/reference/ocr.swift — read on-screen text in frames with Apple Vision (accurate mode).
//
//   ocr f00001.jpg f00002.jpg …
//
// One JSON line per frame. Boxes are normalised 0–1 with a TOP-LEFT origin.
//   {"file":"…","lines":[{"text":"…","x":…,"y":…,"w":…,"h":…,"c":0.98}]}
import Foundation
import Vision
import AppKit

func esc(_ s: String) -> String {
  return s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    .replacingOccurrences(of: "\n", with: " ")
}

for path in CommandLine.arguments.dropFirst() {
  guard let img = NSImage(contentsOfFile: path),
        let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("{\"file\":\"\(esc(path))\",\"error\":\"unreadable\"}")
    continue
  }
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = false
  do { try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req]) } catch {
    print("{\"file\":\"\(esc(path))\",\"error\":\"vision failed\"}")
    continue
  }
  var lines: [String] = []
  for o in req.results ?? [] {
    guard let cand = o.topCandidates(1).first else { continue }
    let r = o.boundingBox
    lines.append(String(format: "{\"text\":\"%@\",\"x\":%.4f,\"y\":%.4f,\"w\":%.4f,\"h\":%.4f,\"c\":%.3f}",
                        esc(cand.string), r.minX, 1.0 - r.maxY, r.width, r.height, cand.confidence))
  }
  print("{\"file\":\"\(esc(path))\",\"lines\":[\(lines.joined(separator: ","))]}")
}

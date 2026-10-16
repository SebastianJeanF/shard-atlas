import Foundation
import Vision

// Keep image recognition on this Mac. The caller owns the temporary source file.
guard CommandLine.arguments.count == 2 else {
    fputs("Provide one image path.\n", stderr)
    exit(2)
}
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
do {
    let handler = VNImageRequestHandler(url: url, options: [:])
    try handler.perform([request])
    let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    let data = try JSONSerialization.data(withJSONObject: ["text": text], options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    fputs("Image text recognition failed: \(error.localizedDescription)\n", stderr)
    exit(1)
}

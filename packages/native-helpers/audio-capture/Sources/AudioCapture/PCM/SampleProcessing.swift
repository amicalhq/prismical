import AVFoundation
import Foundation

// Buffer-to-mono extraction and simple resampling for capture callbacks.

func extractMonoSamples(
    from bufferList: UnsafeMutableAudioBufferListPointer,
    commonFormat: AVAudioCommonFormat,
    channelCount: Int,
    interleaved: Bool
) -> [Float]? {
    guard channelCount > 0 else { return nil }
    guard let firstBuffer = bufferList.first else { return nil }

    let bytesPerSample: Int
    switch commonFormat {
    case .pcmFormatFloat32:
        bytesPerSample = MemoryLayout<Float>.size
    case .pcmFormatFloat64:
        bytesPerSample = MemoryLayout<Double>.size
    case .pcmFormatInt16:
        bytesPerSample = MemoryLayout<Int16>.size
    case .pcmFormatInt32:
        bytesPerSample = MemoryLayout<Int32>.size
    default:
        return nil
    }

    let frameCount: Int
    if interleaved {
        frameCount = Int(firstBuffer.mDataByteSize) / max(bytesPerSample * channelCount, 1)
    } else {
        frameCount = Int(firstBuffer.mDataByteSize) / bytesPerSample
    }

    guard frameCount > 0 else { return nil }
    var output = Array(repeating: Float.zero, count: frameCount)

    switch commonFormat {
    case .pcmFormatFloat32:
        if interleaved {
            guard let data = firstBuffer.mData?.assumingMemoryBound(to: Float.self) else {
                return nil
            }
            for frameIndex in 0..<frameCount {
                let baseIndex = frameIndex * channelCount
                output[frameIndex] = data[baseIndex]
            }
        } else {
            guard let data = bufferList[0].mData?.assumingMemoryBound(to: Float.self) else {
                return nil
            }
            for frameIndex in 0..<frameCount {
                output[frameIndex] = data[frameIndex]
            }
        }
    case .pcmFormatFloat64:
        if interleaved {
            guard let data = firstBuffer.mData?.assumingMemoryBound(to: Double.self) else {
                return nil
            }
            for frameIndex in 0..<frameCount {
                let baseIndex = frameIndex * channelCount
                output[frameIndex] = Float(data[baseIndex])
            }
        } else {
            guard let data = bufferList[0].mData?.assumingMemoryBound(to: Double.self) else {
                return nil
            }
            for frameIndex in 0..<frameCount {
                output[frameIndex] = Float(data[frameIndex])
            }
        }
    case .pcmFormatInt16:
        if interleaved {
            guard let data = firstBuffer.mData?.assumingMemoryBound(to: Int16.self) else {
                return nil
            }
            for frameIndex in 0..<frameCount {
                let baseIndex = frameIndex * channelCount
                output[frameIndex] = normalizeInt16(data[baseIndex])
            }
        } else {
            guard let data = bufferList[0].mData?.assumingMemoryBound(to: Int16.self) else {
                return nil
            }
            for frameIndex in 0..<frameCount {
                output[frameIndex] = normalizeInt16(data[frameIndex])
            }
        }
    case .pcmFormatInt32:
        if interleaved {
            guard let data = firstBuffer.mData?.assumingMemoryBound(to: Int32.self) else {
                return nil
            }
            for frameIndex in 0..<frameCount {
                let baseIndex = frameIndex * channelCount
                output[frameIndex] = normalizeInt32(data[baseIndex])
            }
        } else {
            guard let data = bufferList[0].mData?.assumingMemoryBound(to: Int32.self) else {
                return nil
            }
            for frameIndex in 0..<frameCount {
                output[frameIndex] = normalizeInt32(data[frameIndex])
            }
        }
    default:
        return nil
    }

    return output
}

func resampleLinear(
    samples: [Float],
    from inputSampleRate: Double,
    to outputSampleRate: Double
) -> [Float] {
    guard !samples.isEmpty else { return [] }
    guard inputSampleRate > 0, outputSampleRate > 0 else { return samples }
    if abs(inputSampleRate - outputSampleRate) < 0.5 {
        return samples
    }

    let outputCount = max(
        1,
        Int((Double(samples.count) * outputSampleRate / inputSampleRate).rounded(.toNearestOrAwayFromZero))
    )
    var output = Array(repeating: Float.zero, count: outputCount)
    let step = inputSampleRate / outputSampleRate

    for outputIndex in 0..<outputCount {
        let sourcePosition = Double(outputIndex) * step
        let lowerIndex = min(Int(sourcePosition), samples.count - 1)
        let upperIndex = min(lowerIndex + 1, samples.count - 1)
        let fraction = Float(sourcePosition - Double(lowerIndex))
        let lowerValue = samples[lowerIndex]
        let upperValue = samples[upperIndex]
        output[outputIndex] = lowerValue + (upperValue - lowerValue) * fraction
    }

    return output
}

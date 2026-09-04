import AudioToolbox
import Foundation

// Small buffer-copy helpers shared by the CoreAudio capture callbacks.

func totalAudioBufferListBytes(_ bufferList: UnsafePointer<AudioBufferList>?) -> Int {
    guard let bufferList else { return 0 }
    let buffers = UnsafeMutableAudioBufferListPointer(
        UnsafeMutablePointer(mutating: bufferList)
    )
    return buffers.reduce(0) { total, buffer in
        total + Int(buffer.mDataByteSize)
    }
}

func audioBufferListCount(_ bufferList: UnsafePointer<AudioBufferList>?) -> Int {
    guard let bufferList else { return 0 }
    let buffers = UnsafeMutableAudioBufferListPointer(
        UnsafeMutablePointer(mutating: bufferList)
    )
    return buffers.count
}

func dataFromAudioBuffer(_ buffer: AudioBuffer) -> Data {
    let byteCount = Int(buffer.mDataByteSize)
    guard byteCount > 0 else { return Data() }
    guard let sourceData = buffer.mData else {
        return Data(count: byteCount)
    }
    return Data(bytes: sourceData, count: byteCount)
}

final class CopiedAudioBufferList {
    let pointer: UnsafeMutablePointer<AudioBufferList>

    init?(source: UnsafePointer<AudioBufferList>) {
        let sourceBuffers = UnsafeMutableAudioBufferListPointer(
            UnsafeMutablePointer(mutating: source)
        )
        guard !sourceBuffers.isEmpty else { return nil }

        let rawSize =
            MemoryLayout<AudioBufferList>.size +
            max(0, sourceBuffers.count - 1) * MemoryLayout<AudioBuffer>.stride
        let rawPointer = UnsafeMutableRawPointer.allocate(
            byteCount: rawSize,
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        rawPointer.initializeMemory(as: UInt8.self, repeating: 0, count: rawSize)

        let pointer = rawPointer.bindMemory(to: AudioBufferList.self, capacity: 1)
        pointer.pointee.mNumberBuffers = UInt32(sourceBuffers.count)
        let destinationBuffers = UnsafeMutableAudioBufferListPointer(pointer)

        for (index, sourceBuffer) in sourceBuffers.enumerated() {
            let byteCount = Int(sourceBuffer.mDataByteSize)
            let destinationData = UnsafeMutableRawPointer.allocate(
                byteCount: max(byteCount, 1),
                alignment: 16
            )

            if let sourceData = sourceBuffer.mData, byteCount > 0 {
                destinationData.copyMemory(from: sourceData, byteCount: byteCount)
            } else if byteCount > 0 {
                destinationData.initializeMemory(as: UInt8.self, repeating: 0, count: byteCount)
            }

            destinationBuffers[index] = AudioBuffer(
                mNumberChannels: sourceBuffer.mNumberChannels,
                mDataByteSize: sourceBuffer.mDataByteSize,
                mData: destinationData
            )
        }

        self.pointer = pointer
    }

    init?(sourceBuffer: AudioBuffer) {
        let rawPointer = UnsafeMutableRawPointer.allocate(
            byteCount: MemoryLayout<AudioBufferList>.size,
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        rawPointer.initializeMemory(
            as: UInt8.self,
            repeating: 0,
            count: MemoryLayout<AudioBufferList>.size
        )

        let pointer = rawPointer.bindMemory(to: AudioBufferList.self, capacity: 1)
        pointer.pointee.mNumberBuffers = 1
        let destinationBuffers = UnsafeMutableAudioBufferListPointer(pointer)

        let byteCount = Int(sourceBuffer.mDataByteSize)
        let destinationData = UnsafeMutableRawPointer.allocate(
            byteCount: max(byteCount, 1),
            alignment: 16
        )

        if let sourceData = sourceBuffer.mData, byteCount > 0 {
            destinationData.copyMemory(from: sourceData, byteCount: byteCount)
        } else if byteCount > 0 {
            destinationData.initializeMemory(as: UInt8.self, repeating: 0, count: byteCount)
        }

        destinationBuffers[0] = AudioBuffer(
            mNumberChannels: sourceBuffer.mNumberChannels,
            mDataByteSize: sourceBuffer.mDataByteSize,
            mData: destinationData
        )

        self.pointer = pointer
    }

    deinit {
        let buffers = UnsafeMutableAudioBufferListPointer(pointer)
        for buffer in buffers where buffer.mData != nil {
            buffer.mData?.deallocate()
        }
        pointer.deallocate()
    }
}

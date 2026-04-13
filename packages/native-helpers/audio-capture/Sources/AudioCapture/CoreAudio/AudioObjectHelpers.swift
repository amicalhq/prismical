import AVFoundation
import CoreAudio
import Foundation

// CoreAudio device, stream, and property helpers used by the capture backends.

func makePropertyAddress(
    selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
    element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: scope,
        mElement: element
    )
}

func coreAudioCheck(_ status: OSStatus, operation: String) throws {
    guard status == noErr else {
        throw CaptureError.coreAudioOperationFailed(operation, status)
    }
}

func getAudioObjectProperty<T>(
    objectID: AudioObjectID,
    selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
    element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain,
    type: T.Type = T.self
) throws -> T {
    var address = makePropertyAddress(selector: selector, scope: scope, element: element)
    var dataSize = UInt32(MemoryLayout<T>.size)
    let rawPointer = UnsafeMutableRawPointer.allocate(
        byteCount: Int(dataSize),
        alignment: max(MemoryLayout<T>.alignment, 8)
    )
    defer { rawPointer.deallocate() }

    rawPointer.initializeMemory(as: UInt8.self, repeating: 0, count: Int(dataSize))

    try coreAudioCheck(
        AudioObjectGetPropertyData(
            objectID,
            &address,
            0,
            nil,
            &dataSize,
            rawPointer
        ),
        operation: "AudioObjectGetPropertyData(\(selector))"
    )

    guard Int(dataSize) == MemoryLayout<T>.size else {
        throw CaptureError.unsupportedSystemAudioCapture
    }

    return rawPointer.load(as: T.self)
}

func getAudioObjectArrayProperty<T>(
    objectID: AudioObjectID,
    selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
    element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain,
    type: T.Type = T.self
) throws -> [T] {
    var address = makePropertyAddress(selector: selector, scope: scope, element: element)
    var dataSize: UInt32 = 0

    try coreAudioCheck(
        AudioObjectGetPropertyDataSize(objectID, &address, 0, nil, &dataSize),
        operation: "AudioObjectGetPropertyDataSize(\(selector))"
    )

    let count = Int(dataSize) / MemoryLayout<T>.stride
    guard count > 0 else { return [] }

    let pointer = UnsafeMutablePointer<T>.allocate(capacity: count)
    defer { pointer.deallocate() }

    try coreAudioCheck(
        AudioObjectGetPropertyData(
            objectID,
            &address,
            0,
            nil,
            &dataSize,
            pointer
        ),
        operation: "AudioObjectGetPropertyData(\(selector))"
    )

    return Array(UnsafeBufferPointer(start: pointer, count: count))
}

func getAudioObjectStringProperty(
    objectID: AudioObjectID,
    selector: AudioObjectPropertySelector
) throws -> String {
    var rawValue: CFString = "" as CFString
    var address = makePropertyAddress(selector: selector)
    var dataSize = UInt32(MemoryLayout<CFString>.size)

    try withUnsafeMutablePointer(to: &rawValue) { pointer in
        try coreAudioCheck(
            AudioObjectGetPropertyData(
                objectID,
                &address,
                0,
                nil,
                &dataSize,
                pointer
            ),
            operation: "AudioObjectGetPropertyData(\(selector))"
        )
    }

    return rawValue as String
}

func getCurrentProcessObjectID() -> AudioObjectID? {
    let processID = Int32(getpid())
    guard let processObjects = try? getAudioObjectArrayProperty(
        objectID: AudioObjectID(kAudioObjectSystemObject),
        selector: kAudioHardwarePropertyProcessObjectList,
        type: AudioObjectID.self
    ) else {
        return nil
    }

    for processObjectID in processObjects {
        guard let activePID: pid_t = try? getAudioObjectProperty(
            objectID: processObjectID,
            selector: kAudioProcessPropertyPID,
            type: pid_t.self
        ) else {
            continue
        }

        if activePID == processID {
            return processObjectID
        }
    }

    return nil
}

func getDefaultOutputDeviceUID() throws -> String {
    let outputDeviceID: AudioObjectID = try getAudioObjectProperty(
        objectID: AudioObjectID(kAudioObjectSystemObject),
        selector: kAudioHardwarePropertyDefaultOutputDevice,
        type: AudioObjectID.self
    )

    guard outputDeviceID != kAudioObjectUnknown else {
        throw CaptureError.unsupportedSystemAudioCapture
    }

    return try getAudioObjectStringProperty(
        objectID: outputDeviceID,
        selector: kAudioDevicePropertyDeviceUID
    )
}

func getDefaultInputDeviceUID() throws -> String {
    let inputDeviceID: AudioObjectID = try getAudioObjectProperty(
        objectID: AudioObjectID(kAudioObjectSystemObject),
        selector: kAudioHardwarePropertyDefaultInputDevice,
        type: AudioObjectID.self
    )

    guard inputDeviceID != kAudioObjectUnknown else {
        throw CaptureError.microphoneUnavailable
    }

    return try getAudioObjectStringProperty(
        objectID: inputDeviceID,
        selector: kAudioDevicePropertyDeviceUID
    )
}

func getDefaultInputDeviceID() throws -> AudioDeviceID {
    let inputDeviceID: AudioObjectID = try getAudioObjectProperty(
        objectID: AudioObjectID(kAudioObjectSystemObject),
        selector: kAudioHardwarePropertyDefaultInputDevice,
        type: AudioObjectID.self
    )

    guard inputDeviceID != kAudioObjectUnknown else {
        throw CaptureError.microphoneUnavailable
    }

    return inputDeviceID
}

func getDeviceStreamFormats(
    deviceID: AudioObjectID,
    scope: AudioObjectPropertyScope
) throws -> [AVAudioFormat] {
    let streamIDs: [AudioObjectID] = try getAudioObjectArrayProperty(
        objectID: deviceID,
        selector: kAudioDevicePropertyStreams,
        scope: scope,
        type: AudioObjectID.self
    )

    guard !streamIDs.isEmpty else {
        throw CaptureError.unsupportedSystemAudioCapture
    }

    return try streamIDs.map { streamID in
        var streamFormatDescription: AudioStreamBasicDescription = try getAudioObjectProperty(
            objectID: streamID,
            selector: kAudioStreamPropertyVirtualFormat,
            type: AudioStreamBasicDescription.self
        )

        guard let streamFormat = AVAudioFormat(streamDescription: &streamFormatDescription) else {
            throw CaptureError.unsupportedSystemAudioBuffer
        }

        return streamFormat
    }
}

func attachTapToAggregateDevice(
    aggregateDeviceID: AudioObjectID,
    tapUID: String
) throws {
    var address = makePropertyAddress(selector: kAudioAggregateDevicePropertyTapList)
    var propertySize: UInt32 = 0
    let sizeStatus = AudioObjectGetPropertyDataSize(
        aggregateDeviceID,
        &address,
        0,
        nil,
        &propertySize
    )

    if sizeStatus != noErr && sizeStatus != kAudioHardwareUnknownPropertyError {
        throw CaptureError.coreAudioOperationFailed(
            "AudioObjectGetPropertyDataSize(\(kAudioAggregateDevicePropertyTapList))",
            sizeStatus
        )
    }

    var tapList: CFArray? = nil
    if propertySize > 0 {
        try withUnsafeMutablePointer(to: &tapList) { pointer in
            try coreAudioCheck(
                AudioObjectGetPropertyData(
                    aggregateDeviceID,
                    &address,
                    0,
                    nil,
                    &propertySize,
                    pointer
                ),
                operation: "AudioObjectGetPropertyData(\(kAudioAggregateDevicePropertyTapList))"
            )
        }
    }

    var tapUIDs = (tapList as? [CFString]) ?? []
    let targetUID = tapUID as CFString
    if !tapUIDs.contains(targetUID) {
        tapUIDs.append(targetUID)
    }

    var updatedTapList: CFArray = tapUIDs as CFArray
    propertySize = UInt32(MemoryLayout<CFString>.stride * tapUIDs.count)
    try withUnsafeMutablePointer(to: &updatedTapList) { pointer in
        try coreAudioCheck(
            AudioObjectSetPropertyData(
                aggregateDeviceID,
                &address,
                0,
                nil,
                propertySize,
                pointer
            ),
            operation: "AudioObjectSetPropertyData(\(kAudioAggregateDevicePropertyTapList))"
        )
    }
}

import AVFoundation
import CoreAudio
import Foundation

// Callback-side buffer selection and trace logging for the aggregate/tap stream.

extension SystemAudioCapture {
    // Pick the best callback buffer, trace what arrived, and enqueue the selected source for normalization.
    func handle(
        now: UnsafePointer<AudioTimeStamp>?,
        inputData: UnsafePointer<AudioBufferList>?,
        inputTime: UnsafePointer<AudioTimeStamp>?,
        outputData: UnsafeMutablePointer<AudioBufferList>?,
        outputTime: UnsafePointer<AudioTimeStamp>?
    ) {
        let callbackSequence = self.callbackSequence
        self.callbackSequence &+= 1
        let inputBytes = totalAudioBufferListBytes(inputData)
        let inputBufferCount = audioBufferListCount(inputData)
        let outputBytes = totalAudioBufferListBytes(
            outputData.map { UnsafePointer<AudioBufferList>($0) }
        )
        let outputBufferCount = audioBufferListCount(
            outputData.map { UnsafePointer<AudioBufferList>($0) }
        )

        let fallbackBufferListPointer: UnsafePointer<AudioBufferList>? =
            inputBytes > 0
            ? inputData
            : outputData.map { UnsafePointer<AudioBufferList>($0) }
        let selectedSource =
            inputBytes > 0 ? "input" : (outputBytes > 0 ? "output" : "none")
        let inputHostTime = inputTime?.pointee.mHostTime ?? now?.pointee.mHostTime
        let outputHostTime = outputTime?.pointee.mHostTime ?? now?.pointee.mHostTime
        let fallbackHostTime = now?.pointee.mHostTime
        let nowSampleTime = now?.pointee.mSampleTime
        let inputSampleTime = inputTime?.pointee.mSampleTime
        let outputSampleTime = outputTime?.pointee.mSampleTime

        if callbackLogCount < 4 {
            callbackLogCount += 1
            Logger.info(
                "System audio callback: inputBytes=\(inputBytes) inputBuffers=\(inputBufferCount) outputBytes=\(outputBytes) outputBuffers=\(outputBufferCount) selected=\(selectedSource)"
            )
        }

        let selectedInputBuffer =
            inputBytes > 0
            ? inputData.flatMap { selectInputBuffer(from: $0) }
            : nil
        let selectedAggregateMicrophoneBuffer =
            captureAggregateInput && inputBytes > 0
            ? inputData.flatMap {
                selectAggregateMicrophoneBuffer(
                    from: $0,
                    excluding: selectedInputBuffer?.index
                )
            }
            : nil

        var callbackTraceMetadata: [String: Any] = [
            "inputBytes": inputBytes,
            "inputBufferCount": inputBufferCount,
            "outputBytes": outputBytes,
            "outputBufferCount": outputBufferCount,
            "selectedSource": selectedSource
        ]
        if let value = now?.pointee.mHostTime {
            callbackTraceMetadata["nowHostTime"] = Int64(value)
        }
        if let value = inputHostTime {
            callbackTraceMetadata["inputHostTime"] = Int64(value)
        }
        if let value = outputHostTime {
            callbackTraceMetadata["outputHostTime"] = Int64(value)
        }
        if let value = fallbackHostTime {
            callbackTraceMetadata["fallbackHostTime"] = Int64(value)
        }
        if let value = nowSampleTime {
            callbackTraceMetadata["nowSampleTime"] = value
        }
        if let value = inputSampleTime {
            callbackTraceMetadata["inputSampleTime"] = value
        }
        if let value = outputSampleTime {
            callbackTraceMetadata["outputSampleTime"] = value
        }
        if let selectedInputBuffer {
            callbackTraceMetadata["selectedInputBufferIndex"] = selectedInputBuffer.index
            callbackTraceMetadata["selectedInputChannels"] = Int(selectedInputBuffer.format.channelCount)
            callbackTraceMetadata["selectedInputInterleaved"] = selectedInputBuffer.format.isInterleaved
        }
        if let selectedAggregateMicrophoneBuffer {
            callbackTraceMetadata["selectedAggregateMicBufferIndex"] = selectedAggregateMicrophoneBuffer.index
            callbackTraceMetadata["selectedAggregateMicChannels"] = Int(selectedAggregateMicrophoneBuffer.format.channelCount)
            callbackTraceMetadata["selectedAggregateMicInterleaved"] = selectedAggregateMicrophoneBuffer.format.isInterleaved
        }
        callbackTraceMetadata["callbackSequence"] = Int64(callbackSequence)

        traceWriter?.record(
            event: "system_audio_callback",
            metadata: callbackTraceMetadata
        )

        traceCallbackBuffers(
            scope: "input",
            bufferListPointer: inputData,
            availableFormats: aggregateInputFormats,
            callbackSequence: callbackSequence,
            selectedInputBufferIndex: selectedInputBuffer?.index,
            selectedAggregateMicrophoneBufferIndex: selectedAggregateMicrophoneBuffer?.index,
            selectedSource: selectedSource,
            now: now,
            inputTime: inputTime,
            outputTime: outputTime
        )
        traceCallbackBuffers(
            scope: "output",
            bufferListPointer: outputData.map { UnsafePointer<AudioBufferList>($0) },
            availableFormats: aggregateOutputFormats,
            callbackSequence: callbackSequence,
            selectedInputBufferIndex: selectedInputBuffer?.index,
            selectedAggregateMicrophoneBufferIndex: selectedAggregateMicrophoneBuffer?.index,
            selectedSource: selectedSource,
            now: now,
            inputTime: inputTime,
            outputTime: outputTime
        )

        let selectedBufferList: CopiedAudioBufferList?
        let selectedFormat: AVAudioFormat?
        let effectiveSourceSampleRate: Double?
        let effectiveHostTime: UInt64?
        let effectiveSource: String

        if let selectedInputBuffer {
            selectedBufferList = selectedInputBuffer.bufferList
            selectedFormat = selectedInputBuffer.format
            effectiveSourceSampleRate =
                aggregateDeviceSampleRate ??
                selectedInputBuffer.format.sampleRate
            effectiveHostTime = inputHostTime ?? fallbackHostTime
            effectiveSource = "input[\(selectedInputBuffer.index)]"
        } else if
            let selectedBufferListPointer = fallbackBufferListPointer,
            let copiedBufferList = CopiedAudioBufferList(source: selectedBufferListPointer),
            let sourceFormat
        {
            selectedBufferList = copiedBufferList
            selectedFormat = sourceFormat
            effectiveSourceSampleRate =
                aggregateDeviceSampleRate ??
                sourceSampleRate ??
                sourceFormat.sampleRate
            effectiveHostTime =
                outputBytes > 0
                ? (outputHostTime ?? fallbackHostTime)
                : fallbackHostTime
            effectiveSource = selectedSource
        } else {
            return
        }

        if let selectedAggregateMicrophoneBuffer,
           let onAggregateMicrophoneSamples
        {
            processingQueue.async { [weak self] in
                guard let self else { return }
                self.process(
                    selectedAggregateMicrophoneBuffer.bufferList,
                    format: selectedAggregateMicrophoneBuffer.format,
                    sourceSampleRate:
                        self.aggregateDeviceSampleRate ??
                        selectedAggregateMicrophoneBuffer.format.sampleRate,
                    selectedSource: "aggregate-mic[\(selectedAggregateMicrophoneBuffer.index)]",
                    traceChannelBase: "aggregate-mic",
                    callbackSequence: callbackSequence,
                    hostTime: inputHostTime ?? fallbackHostTime,
                    onSamples: onAggregateMicrophoneSamples
                )
            }
        }

        processingQueue.async { [weak self] in
            guard
                let self,
                let selectedBufferList,
                let selectedFormat
            else { return }
            self.process(
                selectedBufferList,
                format: selectedFormat,
                sourceSampleRate: effectiveSourceSampleRate ?? selectedFormat.sampleRate,
                selectedSource: effectiveSource,
                traceChannelBase: "system-selected",
                callbackSequence: callbackSequence,
                hostTime: effectiveHostTime,
                onSamples: self.onSamples,
                preResampleDebugWriter: self.preResampleDebugWriter,
                postResampleDebugWriter: self.postResampleDebugWriter
            )
        }
    }

    func selectInputBuffer(
        from bufferListPointer: UnsafePointer<AudioBufferList>
    ) -> (bufferList: CopiedAudioBufferList, format: AVAudioFormat, index: Int)? {
        let sourceBuffers = UnsafeMutableAudioBufferListPointer(
            UnsafeMutablePointer(mutating: bufferListPointer)
        )
        guard !sourceBuffers.isEmpty else { return nil }
        guard let sourceFormat else { return nil }

        let selectedIndex = preferredInputBufferIndex(
            buffers: sourceBuffers,
            preferredFormat: sourceFormat,
            availableFormats: aggregateInputFormats
        )
        guard selectedIndex < sourceBuffers.count else { return nil }
        guard let copiedBufferList = CopiedAudioBufferList(sourceBuffer: sourceBuffers[selectedIndex]) else {
            return nil
        }

        let format =
            aggregateInputFormats.indices.contains(selectedIndex)
            ? aggregateInputFormats[selectedIndex]
            : sourceFormat

        if selectedInputBufferLogCount < 4 {
            selectedInputBufferLogCount += 1
            Logger.info(
                "System audio selected input buffer[\(selectedIndex)]: preferredChannels=\(sourceFormat.channelCount) preferredInterleaved=\(sourceFormat.isInterleaved) actualChannels=\(format.channelCount) actualInterleaved=\(format.isInterleaved)"
            )
        }

        return (copiedBufferList, format, selectedIndex)
    }

    func selectAggregateMicrophoneBuffer(
        from bufferListPointer: UnsafePointer<AudioBufferList>,
        excluding excludedIndex: Int?
    ) -> (bufferList: CopiedAudioBufferList, format: AVAudioFormat, index: Int)? {
        let sourceBuffers = UnsafeMutableAudioBufferListPointer(
            UnsafeMutablePointer(mutating: bufferListPointer)
        )
        guard !sourceBuffers.isEmpty else { return nil }

        let candidateIndex =
            sourceBuffers.indices.first(where: { index in
                guard let excludedIndex else { return true }
                return index != excludedIndex
            })

        guard let candidateIndex, candidateIndex < sourceBuffers.count else { return nil }
        guard let copiedBufferList = CopiedAudioBufferList(sourceBuffer: sourceBuffers[candidateIndex]) else {
            return nil
        }

        let format =
            aggregateInputFormats.indices.contains(candidateIndex)
            ? aggregateInputFormats[candidateIndex]
            : (sourceFormat ?? targetFormat)

        return (copiedBufferList, format, candidateIndex)
    }

    func preferredInputBufferIndex(
        buffers: UnsafeMutableAudioBufferListPointer,
        preferredFormat: AVAudioFormat,
        availableFormats: [AVAudioFormat]
    ) -> Int {
        guard buffers.count > 1 else { return 0 }

        if let exactMatchIndex = availableFormats.firstIndex(where: {
            $0.channelCount == preferredFormat.channelCount &&
            $0.isInterleaved == preferredFormat.isInterleaved
        }), exactMatchIndex < buffers.count {
            return exactMatchIndex
        }

        if let channelMatchIndex = availableFormats.firstIndex(where: {
            $0.channelCount == preferredFormat.channelCount
        }), channelMatchIndex < buffers.count {
            return channelMatchIndex
        }

        if let bufferChannelMatchIndex = buffers.enumerated().first(where: {
            AVAudioChannelCount($0.element.mNumberChannels) == preferredFormat.channelCount
        })?.offset {
            return bufferChannelMatchIndex
        }

        if preferredFormat.channelCount == 1,
           let monoBufferIndex = buffers.enumerated().first(where: {
               $0.element.mNumberChannels == 1
           })?.offset {
            return monoBufferIndex
        }

        return 0
    }

    func traceCallbackBuffers(
        scope: String,
        bufferListPointer: UnsafePointer<AudioBufferList>?,
        availableFormats: [AVAudioFormat],
        callbackSequence: UInt64,
        selectedInputBufferIndex: Int?,
        selectedAggregateMicrophoneBufferIndex: Int?,
        selectedSource: String,
        now: UnsafePointer<AudioTimeStamp>?,
        inputTime: UnsafePointer<AudioTimeStamp>?,
        outputTime: UnsafePointer<AudioTimeStamp>?
    ) {
        guard let traceWriter, let bufferListPointer else { return }

        let sourceBuffers = UnsafeMutableAudioBufferListPointer(
            UnsafeMutablePointer(mutating: bufferListPointer)
        )

        for (bufferIndex, buffer) in sourceBuffers.enumerated() {
            var metadata: [String: Any] = [
                "callbackSequence": Int64(callbackSequence),
                "scope": scope,
                "bufferIndex": bufferIndex,
                "selectedSource": selectedSource,
                "byteCount": Int(buffer.mDataByteSize),
                "bufferChannels": Int(buffer.mNumberChannels),
                "isSelectedInputBuffer": selectedInputBufferIndex == bufferIndex,
                "isSelectedAggregateMicBuffer": selectedAggregateMicrophoneBufferIndex == bufferIndex
            ]
            metadata.merge(audioTimeStampFields(now, prefix: "now")) { _, new in new }
            metadata.merge(audioTimeStampFields(inputTime, prefix: "input")) { _, new in new }
            metadata.merge(audioTimeStampFields(outputTime, prefix: "output")) { _, new in new }
            let format =
                availableFormats.indices.contains(bufferIndex)
                ? availableFormats[bufferIndex]
                : nil
            metadata.merge(avAudioFormatFields(format, prefix: "buffer")) { _, new in new }

            traceWriter.recordBytes(
                event: "system_audio_callback_buffer",
                channel: "system-callback-\(scope)-buffer-\(bufferIndex)",
                payload: dataFromAudioBuffer(buffer),
                metadata: metadata
            )
        }
    }
}

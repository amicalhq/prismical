#include "prismical_aec3.h"

#include <algorithm>
#include <cstdint>
#include <deque>
#include <optional>
#include <vector>

namespace {

struct PrismicalAec3State {
  int sample_rate_hz;
  int channels;
  int stream_delay_ms;
  int frame_samples;
  std::vector<float> last_render_frame;
  std::vector<float> render_remainder;
  std::vector<float> capture_remainder;
};

struct TimedAudioSegment {
  int64_t start_sample_index;
  std::vector<float> samples;

  int64_t EndSampleIndex() const {
    return start_sample_index + static_cast<int64_t>(samples.size());
  }
};

struct TimedSessionOutputFrame {
  int32_t source;
  int64_t start_sample_index;
  std::vector<float> samples;
};

struct PrismicalAec3TimedSessionState {
  PrismicalAec3TimedSessionState(
      int sample_rate_hz,
      int channels,
      int microphone_holdback_ms
  )
      : aec{
            sample_rate_hz,
            channels,
            0,
            sample_rate_hz / 100 * channels,
            {},
            {},
            {},
        },
        frame_samples(aec.frame_samples),
        microphone_holdback_samples(
            (static_cast<int64_t>(sample_rate_hz) *
             static_cast<int64_t>(channels) *
             static_cast<int64_t>(std::max(0, microphone_holdback_ms))) /
            1000),
        render_retention_samples(
            static_cast<int64_t>(sample_rate_hz) *
            static_cast<int64_t>(channels) *
            5) {}

  PrismicalAec3State aec;
  int frame_samples;
  int64_t microphone_holdback_samples;
  int64_t render_retention_samples;
  std::vector<TimedAudioSegment> microphone_segments;
  std::vector<TimedAudioSegment> render_segments;
  std::vector<float> pending_system_packet_samples;
  std::deque<TimedSessionOutputFrame> output_frames;
  std::optional<int64_t> timeline_start_sample_index;
  std::optional<int64_t> next_microphone_frame_start;
  std::optional<int64_t> next_render_frame_start;
  std::optional<int64_t> next_system_packet_frame_start;
  std::optional<int64_t> next_expected_system_packet_input_sample_index;
  int64_t latest_microphone_sample_index = 0;
  int64_t latest_render_sample_index = 0;
};

PrismicalAec3State* ToState(PrismicalAec3Handle* handle) {
  return reinterpret_cast<PrismicalAec3State*>(handle);
}

PrismicalAec3TimedSessionState* ToTimedSession(
    PrismicalAec3TimedSessionHandle* handle
) {
  return reinterpret_cast<PrismicalAec3TimedSessionState*>(handle);
}

void ResetAecState(PrismicalAec3State* state) {
  if (state == nullptr) {
    return;
  }

  state->stream_delay_ms = 0;
  state->last_render_frame.clear();
  state->render_remainder.clear();
  state->capture_remainder.clear();
}

void PushOutputFrame(
    PrismicalAec3TimedSessionState* session,
    int32_t source,
    int64_t start_sample_index,
    std::vector<float> samples
) {
  if (session == nullptr || samples.empty()) {
    return;
  }

  session->output_frames.push_back(TimedSessionOutputFrame{
      source,
      start_sample_index,
      std::move(samples),
  });
}

void AppendSegment(
    std::vector<TimedAudioSegment>& segments,
    TimedAudioSegment segment
) {
  if (segment.samples.empty()) {
    return;
  }

  if (!segments.empty()) {
    TimedAudioSegment& last_segment = segments.back();
    if (segment.start_sample_index <= last_segment.EndSampleIndex()) {
      const int overlap = std::max(
          0,
          static_cast<int>(last_segment.EndSampleIndex() - segment.start_sample_index)
      );
      if (overlap >= static_cast<int>(segment.samples.size())) {
        return;
      }

      last_segment.samples.insert(
          last_segment.samples.end(),
          segment.samples.begin() + overlap,
          segment.samples.end()
      );
      return;
    }
  }

  segments.push_back(std::move(segment));
}

bool ExtractSamples(
    const std::vector<TimedAudioSegment>& segments,
    int64_t start_sample_index,
    int frame_length,
    bool fill_silence,
    std::vector<float>& output
) {
  if (frame_length <= 0) {
    output.clear();
    return true;
  }

  const int64_t end_sample_index = start_sample_index + frame_length;
  output.assign(static_cast<size_t>(frame_length), 0.0f);
  int64_t coverage_cursor = start_sample_index;
  bool wrote_samples = false;

  for (const TimedAudioSegment& segment : segments) {
    if (segment.EndSampleIndex() <= start_sample_index) {
      continue;
    }
    if (segment.start_sample_index >= end_sample_index) {
      break;
    }

    const int64_t overlap_start = std::max(start_sample_index, segment.start_sample_index);
    const int64_t overlap_end = std::min(end_sample_index, segment.EndSampleIndex());
    if (overlap_end <= overlap_start) {
      continue;
    }

    if (!fill_silence && overlap_start > coverage_cursor) {
      return false;
    }

    const int source_offset = static_cast<int>(overlap_start - segment.start_sample_index);
    const int destination_offset = static_cast<int>(overlap_start - start_sample_index);
    const int sample_count = static_cast<int>(overlap_end - overlap_start);
    std::copy_n(
        segment.samples.data() + source_offset,
        static_cast<size_t>(sample_count),
        output.data() + destination_offset
    );

    coverage_cursor = overlap_end;
    wrote_samples = true;
  }

  if (!fill_silence && coverage_cursor < end_sample_index) {
    return false;
  }

  return wrote_samples || fill_silence;
}

std::vector<TimedAudioSegment> TrimSegments(
    const std::vector<TimedAudioSegment>& segments,
    int64_t sample_index
) {
  if (sample_index <= 0) {
    return segments;
  }

  std::vector<TimedAudioSegment> trimmed;
  trimmed.reserve(segments.size());

  for (const TimedAudioSegment& segment : segments) {
    if (segment.EndSampleIndex() <= sample_index) {
      continue;
    }

    if (segment.start_sample_index >= sample_index) {
      trimmed.push_back(segment);
      continue;
    }

    const int trim_count = static_cast<int>(sample_index - segment.start_sample_index);
    if (trim_count >= static_cast<int>(segment.samples.size())) {
      continue;
    }

    trimmed.push_back(TimedAudioSegment{
        sample_index,
        std::vector<float>(segment.samples.begin() + trim_count, segment.samples.end()),
    });
  }

  return trimmed;
}

std::vector<float> DequeueSystemPacketFrame(
    PrismicalAec3TimedSessionState* session
) {
  if (session == nullptr) {
    return {};
  }

  if (static_cast<int>(session->pending_system_packet_samples.size()) >= session->frame_samples) {
    std::vector<float> frame(
        session->pending_system_packet_samples.begin(),
        session->pending_system_packet_samples.begin() + session->frame_samples
    );
    session->pending_system_packet_samples.erase(
        session->pending_system_packet_samples.begin(),
        session->pending_system_packet_samples.begin() + session->frame_samples
    );
    return frame;
  }

  std::vector<float> frame(static_cast<size_t>(session->frame_samples), 0.0f);
  if (!session->pending_system_packet_samples.empty()) {
    std::copy(
        session->pending_system_packet_samples.begin(),
        session->pending_system_packet_samples.end(),
        frame.begin()
    );
    session->pending_system_packet_samples.clear();
  }
  return frame;
}

void AppendSystemPacketSamples(
    PrismicalAec3TimedSessionState* session,
    const float* samples,
    int sample_count,
    int64_t start_sample_index
) {
  if (session == nullptr || samples == nullptr || sample_count <= 0) {
    return;
  }

  const int64_t timeline_start =
      session->timeline_start_sample_index.value_or(start_sample_index);

  if (!session->next_expected_system_packet_input_sample_index.has_value()) {
    const int initial_gap_samples = std::max(
        int64_t{0},
        start_sample_index - timeline_start
    );
    if (initial_gap_samples > 0) {
      session->pending_system_packet_samples.insert(
          session->pending_system_packet_samples.end(),
          static_cast<size_t>(initial_gap_samples),
          0.0f
      );
    }
    session->pending_system_packet_samples.insert(
        session->pending_system_packet_samples.end(),
        samples,
        samples + sample_count
    );
    session->next_expected_system_packet_input_sample_index =
        start_sample_index + sample_count;
    return;
  }

  const int64_t expected_start =
      session->next_expected_system_packet_input_sample_index.value_or(start_sample_index);

  if (start_sample_index > expected_start) {
    const int64_t gap_samples = start_sample_index - expected_start;
    session->pending_system_packet_samples.insert(
        session->pending_system_packet_samples.end(),
        static_cast<size_t>(gap_samples),
        0.0f
    );
    session->pending_system_packet_samples.insert(
        session->pending_system_packet_samples.end(),
        samples,
        samples + sample_count
    );
    session->next_expected_system_packet_input_sample_index =
        start_sample_index + sample_count;
    return;
  }

  const int overlap_samples = std::max(
      0,
      static_cast<int>(expected_start - start_sample_index)
  );
  if (overlap_samples >= sample_count) {
    return;
  }

  session->pending_system_packet_samples.insert(
      session->pending_system_packet_samples.end(),
      samples + overlap_samples,
      samples + sample_count
  );
  session->next_expected_system_packet_input_sample_index =
      expected_start + (sample_count - overlap_samples);
}

void PruneMicrophoneSegments(
    PrismicalAec3TimedSessionState* session,
    int64_t sample_index
) {
  if (session == nullptr) {
    return;
  }

  session->microphone_segments = TrimSegments(session->microphone_segments, sample_index);
}

void PruneRenderSegments(PrismicalAec3TimedSessionState* session) {
  if (session == nullptr || session->render_segments.empty()) {
    return;
  }

  const int64_t retention_boundary = std::max(
      int64_t{0},
      session->latest_render_sample_index - session->render_retention_samples
  );
  const int64_t pending_microphone_boundary =
      session->next_microphone_frame_start.value_or(retention_boundary);
  const int64_t pending_render_boundary =
      session->next_render_frame_start.value_or(retention_boundary);
  const int64_t pending_system_packet_boundary =
      session->next_system_packet_frame_start.value_or(retention_boundary);
  const int64_t prune_before = std::min(
      retention_boundary,
      std::min(
          pending_microphone_boundary,
          std::min(pending_render_boundary, pending_system_packet_boundary)
      )
  );

  session->render_segments = TrimSegments(session->render_segments, prune_before);
}

void DrainRenderFrames(
    PrismicalAec3TimedSessionState* session,
    int64_t sample_index_exclusive
) {
  if (session == nullptr || sample_index_exclusive <= 0) {
    return;
  }

  if (!session->next_render_frame_start.has_value()) {
    if (session->render_segments.empty()) {
      return;
    }

    const int64_t first_render_start = session->render_segments.front().start_sample_index;
    session->next_render_frame_start = std::min(
        session->timeline_start_sample_index.value_or(first_render_start),
        first_render_start
    );
  }

  std::vector<float> render_frame;
  while (session->next_render_frame_start.has_value() &&
         session->next_render_frame_start.value() + session->frame_samples <= sample_index_exclusive) {
    const int64_t frame_start = session->next_render_frame_start.value();
    if (!ExtractSamples(
            session->render_segments,
            frame_start,
            session->frame_samples,
            true,
            render_frame)) {
      render_frame.assign(static_cast<size_t>(session->frame_samples), 0.0f);
    }

    session->aec.last_render_frame = render_frame;
    session->next_render_frame_start = frame_start + session->frame_samples;
  }
}

void DrainSystemPackets(
    PrismicalAec3TimedSessionState* session,
    int64_t sample_index_exclusive
) {
  if (session == nullptr || sample_index_exclusive <= 0) {
    return;
  }

  if (!session->next_system_packet_frame_start.has_value()) {
    if (!session->timeline_start_sample_index.has_value()) {
      return;
    }
    session->next_system_packet_frame_start = session->timeline_start_sample_index.value();
  }

  while (session->next_system_packet_frame_start.has_value() &&
         session->next_system_packet_frame_start.value() + session->frame_samples <= sample_index_exclusive) {
    const int64_t frame_start = session->next_system_packet_frame_start.value();
    PushOutputFrame(
        session,
        PRISMICAL_AEC3_TIMED_SESSION_SYSTEM,
        frame_start,
        DequeueSystemPacketFrame(session)
    );
    session->next_system_packet_frame_start = frame_start + session->frame_samples;
  }
}

void EmitMicrophoneFrame(
    PrismicalAec3TimedSessionState* session,
    int64_t start_sample_index,
    const std::vector<float>& capture_samples
) {
  if (session == nullptr || capture_samples.empty()) {
    return;
  }

  PushOutputFrame(
      session,
      PRISMICAL_AEC3_TIMED_SESSION_MIC_RAW,
      start_sample_index,
      capture_samples
  );
  PushOutputFrame(
      session,
      PRISMICAL_AEC3_TIMED_SESSION_MIC_PROCESSED,
      start_sample_index,
      capture_samples
  );
}

void DrainMicrophoneFrames(
    PrismicalAec3TimedSessionState* session,
    int64_t sample_index_exclusive,
    bool flushing
) {
  if (session == nullptr || sample_index_exclusive <= 0) {
    return;
  }

  if (!session->next_microphone_frame_start.has_value()) {
    if (!session->microphone_segments.empty()) {
      const int64_t first_microphone_start =
          session->microphone_segments.front().start_sample_index;
      session->next_microphone_frame_start = std::min(
          session->timeline_start_sample_index.value_or(first_microphone_start),
          first_microphone_start
      );
    } else if (flushing && session->timeline_start_sample_index.has_value()) {
      session->next_microphone_frame_start = session->timeline_start_sample_index.value();
    }
  }

  std::vector<float> microphone_frame;
  while (session->next_microphone_frame_start.has_value() &&
         session->next_microphone_frame_start.value() + session->frame_samples <= sample_index_exclusive) {
    const int64_t frame_start = session->next_microphone_frame_start.value();
    if (!ExtractSamples(
            session->microphone_segments,
            frame_start,
            session->frame_samples,
            true,
            microphone_frame)) {
      microphone_frame.assign(static_cast<size_t>(session->frame_samples), 0.0f);
    }

    DrainRenderFrames(session, frame_start + session->frame_samples);
    DrainSystemPackets(session, frame_start + session->frame_samples);
    EmitMicrophoneFrame(session, frame_start, microphone_frame);

    session->next_microphone_frame_start = frame_start + session->frame_samples;
    PruneMicrophoneSegments(session, session->next_microphone_frame_start.value());
    PruneRenderSegments(session);
  }
}

int64_t MicrophoneDrainBoundary(
    const PrismicalAec3TimedSessionState* session,
    bool flushing
) {
  if (session == nullptr) {
    return 0;
  }

  if (flushing) {
    return session->latest_microphone_sample_index;
  }

  const int64_t render_ready_sample_index =
      session->latest_render_sample_index - session->microphone_holdback_samples;
  if (render_ready_sample_index <= 0) {
    return 0;
  }

  return std::max(
      int64_t{0},
      std::min(session->latest_microphone_sample_index, render_ready_sample_index)
  );
}

void ResetTimedSession(PrismicalAec3TimedSessionState* session) {
  if (session == nullptr) {
    return;
  }

  session->microphone_segments.clear();
  session->render_segments.clear();
  session->pending_system_packet_samples.clear();
  session->output_frames.clear();
  session->timeline_start_sample_index.reset();
  session->next_microphone_frame_start.reset();
  session->next_render_frame_start.reset();
  session->next_system_packet_frame_start.reset();
  session->next_expected_system_packet_input_sample_index.reset();
  session->latest_microphone_sample_index = 0;
  session->latest_render_sample_index = 0;
  ResetAecState(&session->aec);
}

void FinishTimedSession(PrismicalAec3TimedSessionState* session) {
  if (session == nullptr) {
    return;
  }

  const int64_t final_sample_boundary = std::max(
      session->latest_microphone_sample_index,
      session->latest_render_sample_index
  );

  if (final_sample_boundary <= 0) {
    return;
  }

  const int64_t frame_samples = session->frame_samples;
  const int64_t rounded_boundary =
      ((final_sample_boundary + frame_samples - 1) / frame_samples) * frame_samples;

  DrainSystemPackets(session, rounded_boundary);
  DrainMicrophoneFrames(session, rounded_boundary, true);
}

}  // namespace

extern "C" PrismicalAec3Handle * prismical_aec3_create(
    int sample_rate_hz,
    int channels
) {
  auto * state = new PrismicalAec3State{
      sample_rate_hz,
      channels,
      0,
      sample_rate_hz / 100 * channels,
      {},
      {},
      {},
  };
  return reinterpret_cast<PrismicalAec3Handle *>(state);
}

extern "C" void prismical_aec3_destroy(PrismicalAec3Handle * handle) {
  delete ToState(handle);
}

extern "C" void prismical_aec3_analyze_render(
    PrismicalAec3Handle * handle,
    const float * render,
    int frame_count
) {
  auto * state = ToState(handle);
  if (state == nullptr || render == nullptr || frame_count <= 0) {
    return;
  }

  state->last_render_frame.assign(render, render + frame_count);
}

extern "C" void prismical_aec3_process_capture(
    PrismicalAec3Handle * handle,
    const float * capture_in,
    float * capture_out,
    int frame_count
) {
  auto * state = ToState(handle);
  if (state == nullptr || capture_in == nullptr || capture_out == nullptr || frame_count <= 0) {
    return;
  }

  std::copy(capture_in, capture_in + frame_count, capture_out);
}

extern "C" int prismical_aec3_ingest_render_samples(
    PrismicalAec3Handle * handle,
    const float * render,
    int sample_count
) {
  auto * state = ToState(handle);
  if (state == nullptr || render == nullptr || sample_count <= 0) {
    return 0;
  }

  state->render_remainder.insert(
      state->render_remainder.end(),
      render,
      render + sample_count
  );

  int processed_samples = 0;
  while (static_cast<int>(state->render_remainder.size()) >= state->frame_samples) {
    state->last_render_frame.assign(
        state->render_remainder.begin(),
        state->render_remainder.begin() + state->frame_samples
    );
    state->render_remainder.erase(
        state->render_remainder.begin(),
        state->render_remainder.begin() + state->frame_samples
    );
    processed_samples += state->frame_samples;
  }

  return processed_samples;
}

extern "C" int prismical_aec3_process_capture_samples(
    PrismicalAec3Handle * handle,
    const float * capture_in,
    int sample_count,
    float * capture_out,
    int output_capacity
) {
  auto * state = ToState(handle);
  if (state == nullptr || capture_in == nullptr || capture_out == nullptr || sample_count <= 0 || output_capacity <= 0) {
    return 0;
  }

  state->capture_remainder.insert(
      state->capture_remainder.end(),
      capture_in,
      capture_in + sample_count
  );

  int written_samples = 0;
  while (static_cast<int>(state->capture_remainder.size()) >= state->frame_samples &&
         written_samples + state->frame_samples <= output_capacity) {
    std::copy(
        state->capture_remainder.begin(),
        state->capture_remainder.begin() + state->frame_samples,
        capture_out + written_samples
    );
    state->capture_remainder.erase(
        state->capture_remainder.begin(),
        state->capture_remainder.begin() + state->frame_samples
    );
    written_samples += state->frame_samples;
  }

  return written_samples;
}

extern "C" int prismical_aec3_flush_capture(
    PrismicalAec3Handle * handle,
    float * capture_out,
    int output_capacity
) {
  auto * state = ToState(handle);
  if (state == nullptr || capture_out == nullptr || output_capacity <= 0) {
    return 0;
  }
  if (state->capture_remainder.empty()) {
    return 0;
  }

  const int original_count = static_cast<int>(state->capture_remainder.size());
  if (original_count > output_capacity) {
    return 0;
  }

  std::copy(
      state->capture_remainder.begin(),
      state->capture_remainder.end(),
      capture_out
  );
  state->capture_remainder.clear();
  return original_count;
}

extern "C" void prismical_aec3_set_stream_delay_ms(
    PrismicalAec3Handle * handle,
    int delay_ms
) {
  auto * state = ToState(handle);
  if (state == nullptr) {
    return;
  }

  state->stream_delay_ms = std::max(0, delay_ms);
}

extern "C" void prismical_aec3_reset(PrismicalAec3Handle * handle) {
  ResetAecState(ToState(handle));
}

extern "C" PrismicalAec3TimedSessionHandle * prismical_aec3_timed_session_create(
    int sample_rate_hz,
    int channels,
    int microphone_holdback_ms
) {
  if (sample_rate_hz <= 0 || channels <= 0) {
    return nullptr;
  }

  auto * session = new PrismicalAec3TimedSessionState(
      sample_rate_hz,
      channels,
      microphone_holdback_ms
  );
  return reinterpret_cast<PrismicalAec3TimedSessionHandle *>(session);
}

extern "C" void prismical_aec3_timed_session_destroy(
    PrismicalAec3TimedSessionHandle * handle
) {
  delete ToTimedSession(handle);
}

extern "C" void prismical_aec3_timed_session_ingest_microphone(
    PrismicalAec3TimedSessionHandle * handle,
    const float * samples,
    int sample_count,
    int64_t start_sample_index
) {
  auto * session = ToTimedSession(handle);
  if (session == nullptr || samples == nullptr || sample_count <= 0) {
    return;
  }

  AppendSegment(
      session->microphone_segments,
      TimedAudioSegment{
          start_sample_index,
          std::vector<float>(samples, samples + sample_count),
      }
  );

  if (!session->timeline_start_sample_index.has_value()) {
    session->timeline_start_sample_index = start_sample_index;
  }
  session->latest_microphone_sample_index = std::max(
      session->latest_microphone_sample_index,
      start_sample_index + sample_count
  );

  if (!session->next_microphone_frame_start.has_value() &&
      !session->microphone_segments.empty()) {
    session->next_microphone_frame_start =
        session->microphone_segments.front().start_sample_index;
  }

  const int64_t drain_boundary = MicrophoneDrainBoundary(session, false);
  if (drain_boundary > 0) {
    DrainMicrophoneFrames(session, drain_boundary, false);
  }
}

extern "C" void prismical_aec3_timed_session_ingest_render(
    PrismicalAec3TimedSessionHandle * handle,
    const float * samples,
    int sample_count,
    int64_t start_sample_index
) {
  auto * session = ToTimedSession(handle);
  if (session == nullptr || samples == nullptr || sample_count <= 0) {
    return;
  }

  AppendSegment(
      session->render_segments,
      TimedAudioSegment{
          start_sample_index,
          std::vector<float>(samples, samples + sample_count),
      }
  );

  if (session->timeline_start_sample_index.has_value()) {
    session->timeline_start_sample_index = std::min(
        session->timeline_start_sample_index.value(),
        start_sample_index
    );
  } else {
    session->timeline_start_sample_index = start_sample_index;
  }

  AppendSystemPacketSamples(session, samples, sample_count, start_sample_index);
  session->latest_render_sample_index = std::max(
      session->latest_render_sample_index,
      start_sample_index + sample_count
  );

  DrainSystemPackets(session, session->latest_render_sample_index);
  DrainRenderFrames(session, session->latest_render_sample_index);
  const int64_t drain_boundary = MicrophoneDrainBoundary(session, false);
  if (drain_boundary > 0) {
    DrainMicrophoneFrames(session, drain_boundary, false);
  }
  PruneRenderSegments(session);
}

extern "C" void prismical_aec3_timed_session_finish(
    PrismicalAec3TimedSessionHandle * handle
) {
  FinishTimedSession(ToTimedSession(handle));
}

extern "C" int prismical_aec3_timed_session_dequeue_output(
    PrismicalAec3TimedSessionHandle * handle,
    PrismicalAec3TimedSessionOutput * output_info,
    float * output_samples,
    int output_capacity
) {
  auto * session = ToTimedSession(handle);
  if (session == nullptr || output_info == nullptr || output_samples == nullptr || output_capacity <= 0) {
    return 0;
  }
  if (session->output_frames.empty()) {
    return 0;
  }

  const TimedSessionOutputFrame & frame = session->output_frames.front();
  const int sample_count = static_cast<int>(frame.samples.size());
  if (sample_count > output_capacity) {
    return -1;
  }

  std::copy(frame.samples.begin(), frame.samples.end(), output_samples);
  output_info->source = frame.source;
  output_info->start_sample_index = frame.start_sample_index;
  output_info->sample_count = sample_count;
  output_info->reserved = 0;
  session->output_frames.pop_front();
  return sample_count;
}

extern "C" void prismical_aec3_timed_session_reset(
    PrismicalAec3TimedSessionHandle * handle
) {
  ResetTimedSession(ToTimedSession(handle));
}

extern "C" int prismical_aec3_is_real() {
  return 0;
}

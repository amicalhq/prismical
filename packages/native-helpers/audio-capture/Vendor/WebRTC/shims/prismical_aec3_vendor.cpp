#include "prismical_aec3.h"

#include "api/scoped_refptr.h"
#include "api/audio/audio_processing.h"
#include "api/audio/builtin_audio_processing_builder.h"
#include "api/environment/environment_factory.h"

#include <algorithm>
#include <vector>

namespace {

webrtc::scoped_refptr<webrtc::AudioProcessing> CreateAudioProcessing(
    int sample_rate_hz,
    int channels
) {
  webrtc::AudioProcessing::Config config;
  config.pipeline.maximum_internal_processing_rate = 48000;
  config.pipeline.multi_channel_capture = channels > 1;
  config.pipeline.multi_channel_render = channels > 1;
  config.echo_canceller.enabled = true;
  config.high_pass_filter.enabled = false;
  config.noise_suppression.enabled = false;
  config.gain_controller1.enabled = false;
  config.gain_controller2.enabled = false;

  webrtc::BuiltinAudioProcessingBuilder builder(config);
  return builder.Build(webrtc::CreateEnvironment());
}

struct PrismicalAec3State {
  PrismicalAec3State(int sample_rate_hz, int channels)
      : sample_rate_hz(sample_rate_hz),
        channels(channels),
        stream_config(sample_rate_hz, static_cast<size_t>(channels)),
        frame_samples(stream_config.num_frames() * stream_config.num_channels()),
        render_frame(frame_samples, 0.0f),
        capture_frame(frame_samples, 0.0f),
        processed_frame(frame_samples, 0.0f),
        channel_buffers(static_cast<size_t>(channels), nullptr),
        processed_channel_buffers(static_cast<size_t>(channels), nullptr),
        const_channel_buffers(static_cast<size_t>(channels), nullptr),
        apm(CreateAudioProcessing(sample_rate_hz, channels)) {
    BindChannelPointers(render_frame, channel_buffers);
    BindChannelPointers(processed_frame, processed_channel_buffers);
  }

  static void BindChannelPointers(
      std::vector<float>& samples,
      std::vector<float*>& pointers
  ) {
    const size_t channels = pointers.size();
    if (channels == 0) {
      return;
    }

    const size_t samples_per_channel = samples.size() / channels;
    for (size_t channel = 0; channel < channels; ++channel) {
      pointers[channel] = samples.data() + (channel * samples_per_channel);
    }
  }

  static void BindConstChannelPointers(
      const std::vector<float>& samples,
      std::vector<const float*>& pointers
  ) {
    const size_t channels = pointers.size();
    if (channels == 0) {
      return;
    }

    const size_t samples_per_channel = samples.size() / channels;
    for (size_t channel = 0; channel < channels; ++channel) {
      pointers[channel] = samples.data() + (channel * samples_per_channel);
    }
  }

  int sample_rate_hz;
  int channels;
  webrtc::StreamConfig stream_config;
  size_t frame_samples;
  std::vector<float> render_frame;
  std::vector<float> capture_frame;
  std::vector<float> processed_frame;
  std::vector<float*> channel_buffers;
  std::vector<float*> processed_channel_buffers;
  std::vector<const float*> const_channel_buffers;
  webrtc::scoped_refptr<webrtc::AudioProcessing> apm;
};

PrismicalAec3State* ToState(PrismicalAec3Handle* handle) {
  return reinterpret_cast<PrismicalAec3State*>(handle);
}

void CopyAndPad(
    const float* input,
    int frame_count,
    std::vector<float>& destination
) {
  if (input == nullptr || frame_count <= 0) {
    std::fill(destination.begin(), destination.end(), 0.0f);
    return;
  }

  const size_t samples_to_copy = std::min(
      destination.size(),
      static_cast<size_t>(frame_count)
  );
  std::copy_n(input, samples_to_copy, destination.begin());
  std::fill(destination.begin() + samples_to_copy, destination.end(), 0.0f);
}

void CopyProcessedToOutput(
    const std::vector<float>& processed,
    const float* capture_in,
    float* capture_out,
    int frame_count
) {
  if (capture_out == nullptr || frame_count <= 0) {
    return;
  }

  const size_t sample_count = static_cast<size_t>(frame_count);
  const size_t processed_count = std::min(processed.size(), sample_count);
  std::copy_n(processed.data(), processed_count, capture_out);

  if (processed_count < sample_count && capture_in != nullptr) {
    std::copy_n(
        capture_in + processed_count,
        sample_count - processed_count,
        capture_out + processed_count
    );
    return;
  }

  std::fill(
      capture_out + processed_count,
      capture_out + sample_count,
      0.0f
  );
}

}  // namespace

extern "C" PrismicalAec3Handle* prismical_aec3_create(
    int sample_rate_hz,
    int channels
) {
  if (sample_rate_hz <= 0 || channels <= 0) {
    return nullptr;
  }

  auto* state = new PrismicalAec3State(sample_rate_hz, channels);
  if (state->apm == nullptr) {
    delete state;
    return nullptr;
  }

  state->apm->Initialize();
  return reinterpret_cast<PrismicalAec3Handle*>(state);
}

extern "C" void prismical_aec3_destroy(PrismicalAec3Handle* handle) {
  delete ToState(handle);
}

extern "C" void prismical_aec3_analyze_render(
    PrismicalAec3Handle* handle,
    const float* render,
    int frame_count
) {
  auto* state = ToState(handle);
  if (state == nullptr || state->apm == nullptr) {
    return;
  }

  CopyAndPad(render, frame_count, state->render_frame);
  PrismicalAec3State::BindConstChannelPointers(
      state->render_frame,
      state->const_channel_buffers
  );

  const int status = state->apm->ProcessReverseStream(
      state->const_channel_buffers.data(),
      state->stream_config,
      state->stream_config,
      state->channel_buffers.data()
  );
  if (status != 0) {
    std::fill(state->render_frame.begin(), state->render_frame.end(), 0.0f);
  }
}

extern "C" void prismical_aec3_process_capture(
    PrismicalAec3Handle* handle,
    const float* capture_in,
    float* capture_out,
    int frame_count
) {
  auto* state = ToState(handle);
  if (state == nullptr || state->apm == nullptr || capture_out == nullptr) {
    return;
  }

  CopyAndPad(capture_in, frame_count, state->capture_frame);
  PrismicalAec3State::BindConstChannelPointers(
      state->capture_frame,
      state->const_channel_buffers
  );

  state->apm->set_stream_delay_ms(0);
  const int status = state->apm->ProcessStream(
      state->const_channel_buffers.data(),
      state->stream_config,
      state->stream_config,
      state->processed_channel_buffers.data()
  );

  if (status != 0) {
    CopyProcessedToOutput(state->capture_frame, capture_in, capture_out, frame_count);
    return;
  }

  CopyProcessedToOutput(state->processed_frame, capture_in, capture_out, frame_count);
}

extern "C" void prismical_aec3_reset(PrismicalAec3Handle* handle) {
  auto* state = ToState(handle);
  if (state == nullptr || state->apm == nullptr) {
    return;
  }

  state->apm->Initialize();
}

extern "C" int prismical_aec3_is_real() {
  return 1;
}

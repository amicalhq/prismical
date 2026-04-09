#include "prismical_aec3.h"

#include <algorithm>
#include <vector>

namespace {

struct PrismicalAec3State {
  int sample_rate_hz;
  int channels;
  std::vector<float> last_render_frame;
};

PrismicalAec3State * to_state(PrismicalAec3Handle * handle) {
  return reinterpret_cast<PrismicalAec3State *>(handle);
}

}  // namespace

extern "C" PrismicalAec3Handle * prismical_aec3_create(
    int sample_rate_hz,
    int channels
) {
  auto * state = new PrismicalAec3State{
      sample_rate_hz,
      channels,
      {},
  };
  return reinterpret_cast<PrismicalAec3Handle *>(state);
}

extern "C" void prismical_aec3_destroy(PrismicalAec3Handle * handle) {
  delete to_state(handle);
}

extern "C" void prismical_aec3_analyze_render(
    PrismicalAec3Handle * handle,
    const float * render,
    int frame_count
) {
  auto * state = to_state(handle);
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
  auto * state = to_state(handle);
  if (state == nullptr || capture_in == nullptr || capture_out == nullptr || frame_count <= 0) {
    return;
  }

  std::copy(capture_in, capture_in + frame_count, capture_out);
}

extern "C" void prismical_aec3_reset(PrismicalAec3Handle * handle) {
  auto * state = to_state(handle);
  if (state == nullptr) {
    return;
  }

  state->last_render_frame.clear();
}

extern "C" int prismical_aec3_is_real() {
  return 0;
}

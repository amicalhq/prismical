#pragma once

#ifdef __cplusplus
extern "C" {
#endif

typedef void PrismicalAec3Handle;

PrismicalAec3Handle * prismical_aec3_create(int sample_rate_hz, int channels);
void prismical_aec3_destroy(PrismicalAec3Handle * handle);

void prismical_aec3_analyze_render(
  PrismicalAec3Handle * handle,
  const float * render,
  int frame_count
);

void prismical_aec3_process_capture(
  PrismicalAec3Handle * handle,
  const float * capture_in,
  float * capture_out,
  int frame_count
);

void prismical_aec3_reset(PrismicalAec3Handle * handle);

int prismical_aec3_is_real();

#ifdef __cplusplus
}
#endif

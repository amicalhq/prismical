#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void PrismicalAec3Handle;
typedef void PrismicalAec3TimedSessionHandle;

typedef enum PrismicalAec3TimedSessionSource {
  PRISMICAL_AEC3_TIMED_SESSION_MIC_RAW = 1,
  PRISMICAL_AEC3_TIMED_SESSION_SYSTEM = 2,
  PRISMICAL_AEC3_TIMED_SESSION_MIC_PROCESSED = 3
} PrismicalAec3TimedSessionSource;

typedef struct PrismicalAec3TimedSessionOutput {
  int32_t source;
  int64_t start_sample_index;
  int32_t sample_count;
  int32_t reserved;
} PrismicalAec3TimedSessionOutput;

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

int prismical_aec3_ingest_render_samples(
  PrismicalAec3Handle * handle,
  const float * render,
  int sample_count
);

int prismical_aec3_process_capture_samples(
  PrismicalAec3Handle * handle,
  const float * capture_in,
  int sample_count,
  float * capture_out,
  int output_capacity
);

int prismical_aec3_flush_capture(
  PrismicalAec3Handle * handle,
  float * capture_out,
  int output_capacity
);

void prismical_aec3_set_stream_delay_ms(
  PrismicalAec3Handle * handle,
  int delay_ms
);

void prismical_aec3_reset(PrismicalAec3Handle * handle);

PrismicalAec3TimedSessionHandle * prismical_aec3_timed_session_create(
  int sample_rate_hz,
  int channels,
  int microphone_holdback_ms
);

void prismical_aec3_timed_session_destroy(
  PrismicalAec3TimedSessionHandle * handle
);

void prismical_aec3_timed_session_ingest_microphone(
  PrismicalAec3TimedSessionHandle * handle,
  const float * samples,
  int sample_count,
  int64_t start_sample_index
);

void prismical_aec3_timed_session_ingest_render(
  PrismicalAec3TimedSessionHandle * handle,
  const float * samples,
  int sample_count,
  int64_t start_sample_index
);

void prismical_aec3_timed_session_finish(
  PrismicalAec3TimedSessionHandle * handle
);

int prismical_aec3_timed_session_dequeue_output(
  PrismicalAec3TimedSessionHandle * handle,
  PrismicalAec3TimedSessionOutput * output_info,
  float * output_samples,
  int output_capacity
);

void prismical_aec3_timed_session_reset(
  PrismicalAec3TimedSessionHandle * handle
);

int prismical_aec3_is_real();

#ifdef __cplusplus
}
#endif

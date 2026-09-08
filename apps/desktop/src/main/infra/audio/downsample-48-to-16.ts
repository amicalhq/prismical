/**
 * Fixed 3:1 decimator for native 48 kHz recording chunks. A 145-tap Blackman-
 * windowed sinc low-pass (7 kHz cutoff) preserves speech through 6 kHz and
 * suppresses frequencies at/above the output's 8 kHz Nyquist limit.
 * Only compute the filter at retained samples; symmetry halves the multiplies.
 */
const RADIUS = 72;
const CUTOFF = 7_000 / 48_000;

// Store the center and one side of the symmetric kernel, normalized to unity DC gain.
const kernel = (() => {
  const coefficients = new Float64Array(RADIUS + 1);
  coefficients[0] = 2 * CUTOFF;
  let sum = coefficients[0];
  for (let i = 1; i <= RADIUS; i += 1) {
    const window =
      0.42 + 0.5 * Math.cos((Math.PI * i) / RADIUS) + 0.08 * Math.cos((2 * Math.PI * i) / RADIUS);
    coefficients[i] = (Math.sin(2 * Math.PI * CUTOFF * i) / (Math.PI * i)) * window;
    sum += 2 * coefficients[i];
  }
  for (let i = 0; i < coefficients.length; i += 1) coefficients[i] /= sum;
  return coefficients;
})();

/**
 * Center the filter on each output timestamp (no added delay), extending the
 * chunk's endpoint values for the first/last 1.5ms. Each chunk is independent
 * so retries and recovery need no filter history and mic/system never mix.
 * Ceil preserves partial tails to within one 16 kHz sample; capture offsets
 * remain owned by the 48 kHz chunker. The input is never modified.
 */
export const downsample48To16 = (samples: Float32Array): Float32Array => {
  const output = new Float32Array(Math.ceil(samples.length / 3));
  const last = samples.length - 1;
  for (let i = 0; i < output.length; i += 1) {
    const center = i * 3;
    let value = samples[center] * kernel[0];
    if (center >= RADIUS && center + RADIUS <= last) {
      for (let tap = 1; tap <= RADIUS; tap += 1) {
        value += (samples[center - tap] + samples[center + tap]) * kernel[tap];
      }
    } else {
      for (let tap = 1; tap <= RADIUS; tap += 1) {
        value +=
          (samples[Math.max(0, center - tap)] + samples[Math.min(last, center + tap)]) *
          kernel[tap];
      }
    }
    output[i] = value;
  }
  return output;
};

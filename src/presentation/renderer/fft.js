/**
 * @presentation renderer/spectrogram
 *
 * In-place Cooley–Tukey radix-2 Decimation-In-Time FFT.
 * Operates on separate real[] and imag[] Float32Arrays of length N (power of 2).
 *
 * After the call:
 *   real[k], imag[k] = k-th complex DFT coefficient   k ∈ [0, N-1]
 *   Positive frequencies span indices 0 … N/2.
 *
 * @param {Float32Array} real — modified in-place
 * @param {Float32Array} imag — modified in-place
 */
export function fft(real, imag) {
  const n = real.length;

  // ── bit-reversal permutation ──────────────────────────────────────────────
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = real[i]; real[i] = real[j]; real[j] = t;
          t = imag[i]; imag[i] = imag[j]; imag[j] = t;
    }
  }

  // ── butterfly stages ──────────────────────────────────────────────────────
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const ang     = (-2 * Math.PI) / len;
    const wRe     = Math.cos(ang);
    const wIm     = Math.sin(ang);

    for (let i = 0; i < n; i += len) {
      let curRe = 1.0;
      let curIm = 0.0;

      for (let j = 0; j < halfLen; j++) {
        const u = i + j;
        const v = i + j + halfLen;

        const vRe = real[v] * curRe - imag[v] * curIm;
        const vIm = real[v] * curIm + imag[v] * curRe;

        real[v] = real[u] - vRe;
        imag[v] = imag[u] - vIm;
        real[u] = real[u] + vRe;
        imag[u] = imag[u] + vIm;

        const nextRe = curRe * wRe - curIm * wIm;
        curIm        = curRe * wIm + curIm * wRe;
        curRe        = nextRe;
      }
    }
  }
}

/**
 * Generate a raised-cosine (Hann) window of length N.
 * @param {number} n
 * @returns {Float32Array}
 */
export function hannWindow(n) {
  const w = new Float32Array(n);
  const scale = (2 * Math.PI) / (n - 1);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(scale * i));
  return w;
}

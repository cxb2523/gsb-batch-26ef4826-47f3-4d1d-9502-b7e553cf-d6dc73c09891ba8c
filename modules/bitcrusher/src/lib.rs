use wasm_bindgen::prelude::*;
// use web_sys::{console};

/// Lowest bit depth we allow. Below 1 bit the signal degenerates and the
/// quantization step can no longer produce useful output.
const MIN_BITS: f32 = 1.0;
/// Highest bit depth we allow. This keeps `0.5^bits` far away from a
/// denormal/zero step (which would divide by ~0 and produce NaN/Inf).
const MAX_BITS: f32 = 32.0;

#[wasm_bindgen]
pub struct BitcrusherModule {
    bits: f32,
    phaser: f32,
    last: f32,
}

#[wasm_bindgen]
impl BitcrusherModule {
    pub fn new(bits: usize) -> BitcrusherModule {
        BitcrusherModule {
            bits: clamp_bits(bits as f32),
            phaser: 0.0,
            last: 0.0,
        }
    }

    /// Update the bit depth while the module is running.
    ///
    /// The new value is clamped to a sane range so invalid input (negative,
    /// huge, `NaN`) can never produce a NaN/Inf sample. `NaN` is ignored so the
    /// previously configured (valid) depth is kept.
    pub fn set_bits(&mut self, bits: f32) {
        if !bits.is_nan() {
            self.bits = clamp_bits(bits);
        }
    }

    /// Read back the (clamped) bit depth currently in use.
    pub fn bits(&self) -> f32 {
        self.bits
    }

    pub fn process(
        &mut self,
        samples: &js_sys::Float32Array,
        normfreq: f32,
    ) -> js_sys::Float32Array {
        // console::log_1(&"Processing in Rust".into());

        let samples_vec: Vec<f32> = samples.to_vec();

        let output = self.process_vec(samples_vec, normfreq);

        js_sys::Float32Array::from(&output[..])
    }

    pub fn process_vec(&mut self, samples: Vec<f32>, normfreq: f32) -> Vec<f32> {
        let mut output = samples;

        // Guard the crush rate too: a NaN rate would freeze the phaser and a
        // negative one would never trigger a new sample, both effectively
        // muting the effect. Fall back to the historical default.
        let normfreq = if normfreq.is_finite() {
            normfreq.clamp(0.0, 1.0)
        } else {
            0.1
        };

        let step = 0.5_f32.powf(self.bits);

        // Loop over samples and apply bitcrusher effect
        for sample in output.iter_mut() {
            self.phaser += normfreq;
            if self.phaser >= 1.0 {
                self.phaser -= 1.0;
                let next = step * (*sample / step + 0.5).floor();
                // A non-finite input sample must not latch into `last`, which
                // would then poison every following sample.
                if next.is_finite() {
                    self.last = next;
                } else {
                    self.last = 0.0;
                }
            }
            *sample = self.last;
        }

        output
    }
}

fn clamp_bits(bits: f32) -> f32 {
    if bits.is_nan() {
        // Fall back to the historical default instead of poisoning the module
        // with NaN.
        4.0
    } else {
        bits.clamp(MIN_BITS, MAX_BITS)
    }
}

// Don't forget to add this for panic handling
// #[wasm_bindgen(start)]
// pub fn main() {
//     console_error_panic_hook::set_once();
// }

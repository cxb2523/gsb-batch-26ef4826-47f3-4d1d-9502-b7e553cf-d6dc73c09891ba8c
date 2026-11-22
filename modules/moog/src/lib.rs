use wasm_bindgen::prelude::*;

/// Cutoff values outside 0..=1 are clamped before use. The filter internally
/// maps cutoff to its feedback coefficient `f`, which must stay below 1 for the
/// ladder to remain stable.
const MIN_CUTOFF: f32 = 0.0;
const MAX_CUTOFF: f32 = 1.0;
/// Resonance is a gain on the feedback path. Negative values would invert the
/// feedback (and eventually blow up), so we keep it >= 0. The upper bound is
/// enforced again by `fb`'s clamp.
const MIN_RESONANCE: f32 = 0.0;
const MAX_RESONANCE: f32 = 1_000.0;

#[wasm_bindgen]
pub struct MoogModule {
    cutoff: f32,
    resonance: f32,

    // Cached filter coefficients, recomputed whenever cutoff/resonance change.
    // `process_vec` reads these directly so a setter takes effect on the very
    // next process call without touching any audio state.
    f: f32,
    input_factor: f32,
    fb: f32,

    // Input and output
    in1: f32,
    in2: f32,
    in3: f32,
    in4: f32,
    out1: f32,
    out2: f32,
    out3: f32,
    out4: f32,
}

#[wasm_bindgen]
impl MoogModule {
    pub fn new(cutoff: f32, resonance: f32) -> MoogModule {
        // Same sanitizing/clamping rules as the setters so the constructor can
        // never seed the filter with a value the setters would reject.
        let cutoff = clamp_cutoff(sanitize(cutoff, 0.065));
        let resonance = clamp_resonance(sanitize(resonance, 3.5));
        let mut module = MoogModule {
            cutoff,
            resonance,
            f: 0.0,
            input_factor: 0.0,
            fb: 0.0,
            in1: 0.0,
            in2: 0.0,
            in3: 0.0,
            in4: 0.0,
            out1: 0.0,
            out2: 0.0,
            out3: 0.0,
            out4: 0.0,
        };
        module.update_coefficients();
        module
    }

    /// Update the cutoff while running. Coefficients are recomputed
    /// immediately, so the next `process` call uses the new value. Filter
    /// state is intentionally preserved to avoid clicks/discontinuities.
    pub fn set_cutoff(&mut self, cutoff: f32) {
        if cutoff.is_nan() {
            return;
        }
        self.cutoff = clamp_cutoff(cutoff);
        self.update_coefficients();
    }

    /// Update the resonance while running (see `set_cutoff`).
    pub fn set_resonance(&mut self, resonance: f32) {
        if resonance.is_nan() {
            return;
        }
        self.resonance = clamp_resonance(resonance);
        self.update_coefficients();
    }

    /// Read back the cutoff currently in use.
    pub fn cutoff(&self) -> f32 {
        self.cutoff
    }

    /// Read back the resonance currently in use.
    pub fn resonance(&self) -> f32 {
        self.resonance
    }

    pub fn process(&mut self, samples: &js_sys::Float32Array) -> js_sys::Float32Array {
        let samples_vec: Vec<f32> = samples.to_vec();
        let output = self.process_vec(samples_vec);
        js_sys::Float32Array::from(&output[..])
    }

    pub fn process_vec(&mut self, mut samples: Vec<f32>) -> Vec<f32> {
        let f = self.f;
        let input_factor = self.input_factor;
        let fb = self.fb;

        // Loop over samples and apply moog filter
        for sample in samples.iter_mut() {
            let mut base = *sample;
            base -= self.out4 * fb;
            base *= input_factor;

            // Stability guard: a non-finite input (or a denormal collapse) must
            // not poison the filter state forever. Reset and emit silence for
            // this sample instead of propagating NaN/Inf.
            if !base.is_finite() {
                self.reset_state();
                *sample = 0.0;
                continue;
            }

            // Pole 1
            self.out1 = base + 0.3 * self.in1 + (1.0 - f) * self.out1;
            self.in1 = base;

            // Pole 2
            self.out2 = self.out1 + 0.3 * self.in2 + (1.0 - f) * self.out2;
            self.in2 = self.out1;

            // Pole 3
            self.out3 = self.out2 + 0.3 * self.in3 + (1.0 - f) * self.out3;
            self.in3 = self.out2;

            // Pole 4
            self.out4 = self.out3 + 0.3 * self.in4 + (1.0 - f) * self.out4;
            self.in4 = self.out3;

            *sample = self.out4.clamp(-1.0, 1.0);
        }

        samples
    }

    /// Recompute the cached coefficients from `cutoff`/`resonance`.
    fn update_coefficients(&mut self) {
        let f = (self.cutoff * 1.16).clamp(0.0, 0.99);
        self.f = f;
        self.input_factor = 0.35013 * (f * f) * (f * f);
        self.fb = (self.resonance * (1.0 - 0.15 * f * f)).clamp(0.0, 0.95);
    }

    fn reset_state(&mut self) {
        self.in1 = 0.0;
        self.in2 = 0.0;
        self.in3 = 0.0;
        self.in4 = 0.0;
        self.out1 = 0.0;
        self.out2 = 0.0;
        self.out3 = 0.0;
        self.out4 = 0.0;
    }
}

/// Replace NaN with the provided fallback so a bad `new()` argument can't make
/// every sample non-finite.
fn sanitize(value: f32, fallback: f32) -> f32 {
    if value.is_nan() {
        fallback
    } else {
        value
    }
}

fn clamp_cutoff(cutoff: f32) -> f32 {
    cutoff.clamp(MIN_CUTOFF, MAX_CUTOFF)
}

fn clamp_resonance(resonance: f32) -> f32 {
    resonance.clamp(MIN_RESONANCE, MAX_RESONANCE)
}

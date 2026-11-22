use clawdio_moog::MoogModule;
use test_helpers::{
    generate_silence_samples, plotting::plot_waveform_comparison, signal::generate_sine_wave,
};

#[test]
fn test_silence_input() {
    let mut filter = MoogModule::new(0.5, 0.5);
    // Generate silence samples
    let silence = generate_silence_samples();

    // Run the filter process
    let result = filter.process_vec(silence);

    // Output should be close to zero for zero input
    for sample in result {
        assert!(sample.abs() < 0.001, "Sample too large: {}", sample);
    }
}

#[test]
fn test_impulse_response() {
    let mut filter = MoogModule::new(0.5, 0.1);
    // Generate a single impulse sample
    let mut impulse = vec![0.0; 128];
    impulse[0] = 1.0;

    let output = filter.process_vec(impulse);

    // First sample should be non-zero
    assert!(output[0] != 0.0);
    // Should decay over time (lowpass behavior)
    assert!(output[10].abs() < output[0].abs());
}

#[test]
fn test_no_nan_or_inf() {
    let mut filter = MoogModule::new(0.9, 0.9); // High settings
                                                // Generate sine wave samples
    let input_data: Vec<f32> = (0..128).map(|i| (i as f32 * 0.1).sin()).collect();

    let output = filter.process_vec(input_data);

    for (i, sample) in output.iter().enumerate() {
        assert!(
            sample.is_finite(),
            "Found NaN or Inf at index {}: {}",
            i,
            sample
        );
        assert!(
            sample.abs() < 10.0,
            "Output too large at index {}: {}",
            i,
            sample
        );
    }
}

#[test]
fn test_set_cutoff_changes_next_process_call() {
    let input = generate_sine_wave(1024);

    // Same filter state, different cutoff => different output on the very
    // next process call.
    let mut low = MoogModule::new(0.05, 0.3);
    let mut high = MoogModule::new(0.9, 0.3);

    let low_out = low.process_vec(input.clone());
    let high_out = high.process_vec(input.clone());

    assert_ne!(
        low_out, high_out,
        "different cutoffs should produce different output"
    );

    let mut module = MoogModule::new(0.05, 0.3);
    module.process_vec(input.clone()); // establish some internal state
    let before = module.process_vec(input.clone());

    module.set_cutoff(0.9);
    assert!((module.cutoff() - 0.9).abs() < 1e-6);
    let after = module.process_vec(input.clone());

    assert_ne!(before, after, "set_cutoff should change output immediately");
}

#[test]
fn test_set_resonance_changes_next_process_call() {
    let input = generate_sine_wave(1024);

    let mut module = MoogModule::new(0.5, 0.0);
    module.process_vec(input.clone());
    let before = module.process_vec(input.clone());

    module.set_resonance(0.9);
    assert!((module.resonance() - 0.9).abs() < 1e-6);
    let after = module.process_vec(input.clone());

    assert_ne!(
        before, after,
        "set_resonance should change output immediately"
    );
}

#[test]
fn test_setters_clamp_invalid_values() {
    let mut module = MoogModule::new(0.5, 0.5);
    let input = generate_sine_wave(512);

    // Out-of-range values are clamped into a stable range.
    module.set_cutoff(-10.0);
    assert_eq!(module.cutoff(), 0.0);
    module.set_cutoff(10.0);
    assert_eq!(module.cutoff(), 1.0);
    module.set_resonance(-10.0);
    assert_eq!(module.resonance(), 0.0);

    // NaN setters leave the previous value untouched.
    let cutoff_before = module.cutoff();
    let resonance_before = module.resonance();
    module.set_cutoff(f32::NAN);
    module.set_resonance(f32::NAN);
    assert_eq!(module.cutoff(), cutoff_before);
    assert_eq!(module.resonance(), resonance_before);

    // No clamping path may emit NaN/Inf even with hostile input.
    for cutoff in [-10.0, 0.0, 0.5, 1.0, 10.0, f32::INFINITY] {
        for resonance in [-10.0, 0.0, 0.95, 100.0, 1_000.0, f32::INFINITY] {
            module.set_cutoff(cutoff);
            module.set_resonance(resonance);
            let output = module.process_vec(input.clone());
            for (i, sample) in output.iter().enumerate() {
                assert!(
                    sample.is_finite(),
                    "non-finite sample at {} for cutoff {} resonance {}: {}",
                    i,
                    cutoff,
                    resonance,
                    sample
                );
            }
        }
    }
}

#[test]
fn test_setters_do_not_break_stability() {
    let mut module = MoogModule::new(0.1, 0.1);

    // Sweep parameters while processing, the way a user dragging sliders does.
    for step in 0..20 {
        let cutoff = step as f32 / 20.0;
        module.set_cutoff(cutoff);
        module.set_resonance(0.9);

        let input: Vec<f32> = (0..256).map(|i| (i as f32 * 0.02).sin()).collect();
        let output = module.process_vec(input);
        for sample in output {
            assert!(sample.is_finite() && sample.abs() <= 1.0);
        }
    }
}

#[test]
fn test_signal_effect() {
    let num_samples = 1024;
    let mut filter = MoogModule::new(0.7, 0.8);
    let original = generate_sine_wave(num_samples);
    let input = generate_sine_wave(num_samples);
    let output = filter.process_vec(input);

    // Visualize signal
    plot_waveform_comparison(
        &output,
        &original,
        num_samples as f32,
        "Moog Test - Comparison (Sine)",
    )
    .expect("Failed to create plot");
}

#[test]
fn test_stability_over_time() {
    let mut filter = MoogModule::new(0.7, 0.8);

    // Process many samples to test long-term stability
    // Ensures filter decays properly and doesn't go to infinity
    for _ in 0..10 {
        let input: Vec<f32> = (0..1024).map(|i| (i as f32 * 0.01).sin()).collect();
        let output = filter.process_vec(input);

        // Check last few samples are still reasonable
        for &sample in output.iter().rev().take(10) {
            assert!(sample.is_finite() && sample.abs() < 2.0);
        }
    }
}
#[test]
fn test_extreme_settings_long_run_stay_finite() {
    // The worst-case region for a ladder filter: highest cutoff + highest
    // usable resonance, driven with a full-scale square-ish signal for a long
    // time. State must not run away to infinity.
    let mut filter = MoogModule::new(1.0, 1000.0);
    for block in 0..200 {
        let input: Vec<f32> = (0..256)
            .map(|i| if (i / 8) % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        let output = filter.process_vec(input);
        for (i, sample) in output.iter().enumerate() {
            assert!(
                sample.is_finite(),
                "non-finite at block {} sample {}: {}",
                block,
                i,
                sample
            );
        }
    }
}

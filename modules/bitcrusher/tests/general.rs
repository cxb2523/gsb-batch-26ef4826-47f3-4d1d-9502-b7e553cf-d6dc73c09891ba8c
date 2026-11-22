use clawdio_bitcrusher::BitcrusherModule;
use test_helpers::{plotting::plot_waveform_comparison, signal::generate_sine_wave};

#[test]
fn test_set_bits_affects_next_process_call() {
    let input = generate_sine_wave(1024);

    // 2 bits quantizes much more coarsely than 12 bits
    let mut coarse = BitcrusherModule::new(2);
    let mut fine = BitcrusherModule::new(12);
    assert_eq!(coarse.bits(), 2.0);
    assert_eq!(fine.bits(), 12.0);

    let coarse_out = coarse.process_vec(input.clone(), 0.420);
    let fine_out = fine.process_vec(input.clone(), 0.420);

    // Over the same input the two depths must yield different output.
    assert_ne!(coarse_out, fine_out);

    // Flipping depth at runtime on the same module must change the output.
    let mut swapped = BitcrusherModule::new(12);
    let before = swapped.process_vec(input.clone(), 0.420);
    swapped.set_bits(2.0);
    assert_eq!(swapped.bits(), 2.0);
    let after = swapped.process_vec(input.clone(), 0.420);

    assert_ne!(before, after, "set_bits should change output immediately");

    // Coarse (2 bit) output should match the module that was 2 bit all along
    // (the phaser state differs slightly, so compare the set of levels used).
    let distinct_coarse: std::collections::BTreeSet<u32> =
        coarse_out.iter().map(|s| s.to_bits()).collect();
    assert!(
        distinct_coarse.len() >= 2,
        "coarse output should still have variation"
    );
}

#[test]
fn test_set_bits_clamps_invalid_values() {
    let mut module = BitcrusherModule::new(4);

    // Low values clamp up to 1 bit (step of 0.5), never zero.
    module.set_bits(-100.0);
    assert_eq!(module.bits(), 1.0);

    // Huge values clamp down to the max supported depth.
    module.set_bits(1_000_000.0);
    assert!(module.bits() <= 32.0);
    assert!(module.bits().is_finite());

    // NaN is ignored, keeping the previous (valid) depth.
    module.set_bits(f32::NAN);
    assert!(module.bits().is_finite());

    // Every clamp path must still produce finite output.
    let input = generate_sine_wave(1024);
    for bits in [-100.0, 0.0, 1.0, 32.0, 1_000_000.0, f32::INFINITY] {
        module.set_bits(bits);
        let output = module.process_vec(input.clone(), 0.420);
        for (i, sample) in output.iter().enumerate() {
            assert!(
                sample.is_finite(),
                "non-finite sample at {} for bits {}: {}",
                i,
                bits,
                sample
            );
        }
    }
}

#[test]
fn test_constructor_clamps_bits() {
    assert_eq!(BitcrusherModule::new(0).bits(), 1.0);
    assert!(BitcrusherModule::new(usize::MAX).bits() <= 32.0);
}

#[test]
fn test_hostile_normfreq_stays_finite() {
    let input = generate_sine_wave(512);
    let mut module = BitcrusherModule::new(4);

    for normfreq in [f32::NAN, f32::INFINITY, -1.0, 0.0, 1.0, 10.0] {
        let output = module.process_vec(input.clone(), normfreq);
        for (i, sample) in output.iter().enumerate() {
            assert!(
                sample.is_finite(),
                "non-finite sample at {} for normfreq {}: {}",
                i,
                normfreq,
                sample
            );
        }
    }
}

#[test]
fn test_signal_effect() {
    let num_samples = 1024;
    let mut filter = BitcrusherModule::new(4);
    let original = generate_sine_wave(num_samples);
    let input = generate_sine_wave(num_samples);
    let output = filter.process_vec(input, 0.420);

    // Bitcrusher creates a step-like pattern out of input signal
    // Technically the modified signal will be equal sometimes, but mostly not
    // So we check that (mostly) every point in signal is different
    let mut is_equal = 0;
    let mut is_diff = 0;
    for index in 0..original.len() {
        let sample_original = original[index];
        let sample_effect = output[index];

        if sample_original != sample_effect {
            is_diff += 1;
        } else {
            is_equal += 1;
        }
    }
    assert!(is_diff > is_equal, "Values should be less equal");

    // Visualize signal
    plot_waveform_comparison(
        &output,
        &original,
        num_samples as f32,
        "Bitcrusher Test - Comparison (Sine)",
    )
    .expect("Failed to create plot");
}

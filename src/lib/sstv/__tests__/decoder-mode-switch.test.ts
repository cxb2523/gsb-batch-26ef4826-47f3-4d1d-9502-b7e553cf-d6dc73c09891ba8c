import { SSTVDecoder } from '../decoder';
import { SSTV_MODES } from '../constants';

describe('SSTVDecoder mode switching', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  const totalPixels = (mode: keyof typeof SSTV_MODES) =>
    SSTV_MODES[mode].width * SSTV_MODES[mode].height;

  test('rebuilds image buffer, stats and dimensions for the new mode', () => {
    const decoder = new SSTVDecoder(48000, 'ROBOT36');
    decoder.start();

    expect(decoder.getStats().mode).toBe('Robot 36');
    expect(decoder.getStats().totalLines).toBe(240);
    expect(decoder.getImageData().length).toBe(totalPixels('ROBOT36') * 4);

    decoder.setMode('PD120');

    const stats = decoder.getStats();
    expect(stats.mode).toBe('PD 120');
    expect(stats.totalLines).toBe(SSTV_MODES.PD120.height);
    expect(stats.currentLine).toBe(0);
    expect(stats.progress).toBe(0);
    expect(decoder.getDimensions()).toEqual({ width: 640, height: 496 });
    expect(decoder.getImageData().length).toBe(totalPixels('PD120') * 4);
  });

  test('discards the old mode partial image and decoded line count', () => {
    const decoder = new SSTVDecoder(48000, 'ROBOT36');
    decoder.start();

    // Simulate a partially decoded Robot36 frame.
    const oldImage = decoder.getImageData();
    oldImage[0] = 255;
    oldImage[1] = 128;
    oldImage[2] = 64;
    (decoder as any).currentLine = 37;

    decoder.setMode('SCOTTIE_S1');

    const newImage = decoder.getImageData();
    expect((decoder as any).currentLine).toBe(0);

    // No pixel from the old mode survives anywhere in the new buffer.
    let nonBlack = 0;
    for (let i = 0; i < newImage.length; i += 4) {
      if (newImage[i] !== 0 || newImage[i + 1] !== 0 || newImage[i + 2] !== 0) {
        nonBlack++;
      }
    }
    expect(nonBlack).toBe(0);

    // Alpha stays opaque.
    for (let i = 3; i < newImage.length; i += 4) {
      expect(newImage[i]).toBe(255);
    }
  });

  test('drops old-mode audio, sync position and frequency calibration', () => {
    const decoder = new SSTVDecoder(48000, 'ROBOT36');
    decoder.start();

    // Pretend old-mode audio was collected and a sync pulse located.
    (decoder as any).bufferWritePos = 1234;
    (decoder as any).lastSyncPos = 999;
    (decoder as any).frequencyOffset = 0.42;
    const oldSyncDetector = (decoder as any).syncDetector;
    const oldLineDecoder = (decoder as any).lineDecoder;
    (decoder as any).audioBuffer.fill(0.5);
    (decoder as any).demodulatedBuffer.fill(0.5);

    decoder.setMode('PD180');

    expect((decoder as any).bufferWritePos).toBe(0);
    expect((decoder as any).lastSyncPos).toBe(-1);
    expect((decoder as any).frequencyOffset).toBe(0);
    expect((decoder as any).syncDetector).not.toBe(oldSyncDetector);
    expect((decoder as any).lineDecoder).not.toBe(oldLineDecoder);
    expect((decoder as any).audioBuffer.every((v: number) => v === 0)).toBe(true);
    expect((decoder as any).demodulatedBuffer.every((v: number) => v === 0)).toBe(true);
  });

  test('processing resumed audio after a switch cannot emit old-mode lines', () => {
    const decoder = new SSTVDecoder(48000, 'ROBOT36');
    decoder.start();

    // Old mode had decoded a line and seen a sync pulse.
    (decoder as any).currentLine = 12;
    (decoder as any).lastSyncPos = 5000;

    decoder.setMode('PD120');

    // Feed a silent chunk: the decoder must not fabricate a line that bridges
    // an old-mode sync position.
    const chunk = new Float32Array(4096);
    decoder.processSamples(chunk);

    expect(decoder.getStats().currentLine).toBe(0);
    expect(decoder.getStats().mode).toBe('PD 120');
  });

  test('switching to the same mode keeps the current progress', () => {
    const decoder = new SSTVDecoder(48000, 'ROBOT36');
    decoder.start();
    (decoder as any).currentLine = 5;
    const image = decoder.getImageData();

    decoder.setMode('ROBOT36');

    expect(decoder.getStats().currentLine).toBe(5);
    expect(decoder.getImageData()).toBe(image);
  });
});

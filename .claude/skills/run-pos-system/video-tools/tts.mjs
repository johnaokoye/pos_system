import ESpeakNg from 'espeak-ng';
import fs from 'fs';

// Synthesizes `text` to a WAV file at `outPath` using the offline eSpeak-NG
// WASM engine. Returns the duration in seconds (parsed from the WAV header).
export async function synthesize(text, outPath, { voice = 'en-us', speed = 150, pitch = 45 } = {}) {
  const espeak = await ESpeakNg({
    arguments: ['-w', 'out.wav', '-v', voice, '-s', String(speed), '-p', String(pitch), text],
  });
  const data = espeak.FS.readFile('out.wav');
  fs.writeFileSync(outPath, Buffer.from(data));
  return wavDurationSeconds(outPath);
}

function wavDurationSeconds(path) {
  const buf = fs.readFileSync(path);
  // Standard 44-byte PCM WAV header: byte rate at offset 28 (uint32 LE), data size at offset 40.
  const byteRate = buf.readUInt32LE(28);
  const dataSize = buf.readUInt32LE(40);
  return dataSize / byteRate;
}

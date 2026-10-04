/**
 * WSOLA time-stretch for speech.
 *
 * The reader's speed is applied here rather than by the service: an utterance is
 * synthesised once, at rate 1.0, and stretched to whatever the reader has picked
 * on its way to the speaker. That is what makes a rate change cost nothing — no
 * new request, no new decode, only arithmetic on samples that are already in
 * memory.
 *
 * It is also the only way Web Audio can change speed without changing pitch.
 * `AudioBufferSourceNode.playbackRate` resamples, which drags the pitch with it
 * — a voice at 2× comes out as a chipmunk — and the `preservesPitch` that media
 * elements have does not exist on a buffer source. WSOLA instead re-lays whole
 * waveform frames at a different spacing: the periods inside the voice keep
 * their length, so what changes is the tempo and not the speaker.
 *
 * Each splice is placed where the incoming frame lines up best with the tail
 * already written, and the overlap is cross-faded, which keeps the phase
 * continuous through the join. Parameters are SoundTouch's speech defaults.
 */

/** Frame length: long enough to hold a few pitch periods, short enough that a
 *  splice lands inside one phoneme rather than across two. */
const FRAME_SEC = 0.04;

/** Cross-faded into the previous frame at every splice. */
const OVERLAP_SEC = 0.008;

/** How far either side of the nominal input position a splice may be moved
 *  looking for a better join. */
const SEEK_SEC = 0.015;

/**
 * `input` resampled in time: `tempo` > 1 is shorter and faster, `tempo` < 1
 * longer and slower, and the pitch is the same in all three cases.
 *
 * `tempo === 1` hands back a copy, so a caller need not special-case it.
 */
// `ArrayBuffer` rather than the looser `ArrayBufferLike`: `copyToChannel` will
// not take a `SharedArrayBuffer`, and a stretched channel is always a fresh one.
export function timeStretch(
  input: Float32Array<ArrayBuffer>,
  sampleRate: number,
  tempo: number,
): Float32Array<ArrayBuffer> {
  const frame = Math.round(FRAME_SEC * sampleRate);
  const overlap = Math.round(OVERLAP_SEC * sampleRate);
  const seek = Math.round(SEEK_SEC * sampleRate);
  // Too little signal to hold two frames: stretching it would be guesswork.
  if (!(tempo > 0) || tempo === 1 || input.length < 2 * frame) return input.slice();

  const flat = frame - overlap; // samples appended per splice
  const advance = flat * tempo; // input consumed per splice
  const out = new Float32Array(Math.ceil(input.length / tempo) + 2 * frame);

  out.set(input.subarray(0, frame), 0);
  let at = frame;
  // Where the input *would* be read from, kept apart from the splices actually
  // chosen: a search that keeps landing late must not accumulate into drift.
  let nominal = 0;

  for (;;) {
    nominal += advance;
    const target = Math.round(nominal);
    const from = Math.max(0, target - seek);
    const to = Math.min(input.length - frame, target + seek);
    if (to < from) break;

    const tail = at - overlap;
    let best = from;
    let bestScore = -Infinity;
    for (let offset = from; offset <= to; offset += 1) {
      let dot = 0;
      let energy = 0;
      for (let i = 0; i < overlap; i += 1) {
        const sample = input[offset + i]!;
        dot += out[tail + i]! * sample;
        energy += sample * sample;
      }
      // Normalised, and guarded against a window of digital silence: silence
      // correlates with itself at zero energy, and that division is a NaN.
      const score = dot / Math.sqrt(energy + 1e-12);
      if (score > bestScore) {
        bestScore = score;
        best = offset;
      }
    }

    for (let i = 0; i < overlap; i += 1) {
      const blend = i / overlap;
      out[tail + i] = out[tail + i]! * (1 - blend) + input[best + i]! * blend;
    }
    out.set(input.subarray(best + overlap, best + frame), at);
    at += flat;
  }

  return out.slice(0, at);
}

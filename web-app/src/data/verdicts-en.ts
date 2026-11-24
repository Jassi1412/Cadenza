/**
 * The seven rules in English, for the end-of-take card.
 *
 * Each entry says what the rule does, what it measures and which data it reads.
 * It is written from the RML specifications, not from taste: every threshold
 * quoted here lives in `RML_DOCS/RML_TESTS/metrics/*.rml`, and this file must
 * never become a second source of truth for a number the service decides.
 *
 * `tolerance` is quoted as prose on purpose — it describes the specification,
 * it does not decide anything. If a spec changes, this text changes with it.
 */

export type VerdictInfo = {
  key: string;
  name: string;
  does: string;
  measures: string;
  data: string;
};

export const VERDICT_INFO: VerdictInfo[] = [
  {
    key: 'pitch-range',
    name: 'Key range',
    does: 'Checks that every attack lies inside the keys the instrument actually has.',
    measures:
      'Whether the performance contains a pitch outside A0–C8 (MIDI 21–108). A real piano take cannot fail this rule; a transposed file, a wrong octave or a stuck controller can.',
    data: 'The pitch of every attack, compared with the instrument range declared by the monitor.',
  },
  {
    key: 'pitch-agreement',
    name: 'Key agreement',
    does: 'Compares the keys you pressed with the keys written in the score, attack by attack.',
    measures:
      'Whether each attack sounds the key the score asks for at that position. A wrong key, a missed note or a note taken from a neighbouring chord all fall here.',
    data: 'The ordered pitches of the attacks and the ordered pitches of the score, aligned by position.',
  },
  {
    key: 'dynamics-adherence',
    name: 'Strength',
    does: 'Compares how hard each attack was played with the dynamic mark in force at that point.',
    measures:
      'Whether the attack velocity sits inside the band around the written dynamic. It is the rule a practice app usually cannot see: the key is right, the moment is right, the force is not.',
    data: 'The MIDI velocity of every attack and the score’s dynamic marks, each mapped to a target velocity with its own tolerance band.',
  },
  {
    key: 'articulation',
    name: 'Hold',
    does: 'Compares how long each note was held with the articulation written above it.',
    measures:
      'Whether a staccato note was released early enough and a legato or tenuto note was held to its full value. Correct key and correct moment are not enough: the note has to last as written.',
    data: 'The duration between note-on and note-off of every attack, and the articulations and slurs of the score.',
  },
  {
    key: 'chord-jitter',
    name: 'Coordination',
    does: 'Measures the spread between the attacks that the score writes as one chord.',
    measures:
      'Whether notes written together arrived together. An asynchrony of a few tens of milliseconds is audible as a rolled chord, and no note is wrong: every key is the right one.',
    data: 'The timestamps of the attacks that share one onset in the score, compared with the permitted spread.',
  },
  {
    key: 'pedal-toggle',
    name: 'Pedal pairing',
    does: 'Matches every pedal press with the pedal mark written in the score.',
    measures:
      'Whether the pedal goes down where the score writes it and comes up where the score ends the span. A press with no mark, or a span left open, is reported at the position where it happened.',
    data: 'The values of MIDI controller 64 and the pedal spans of the score, compared within a quarter of a beat.',
  },
  {
    key: 'syncopated-pedal',
    name: 'Pedal ordering',
    does: 'Checks the order of presses and releases against the attacks they must not swallow.',
    measures:
      'Whether the pedal change falls after the new chord rather than before it. Releasing too early cuts the previous harmony, pressing too early blurs the new one: the notes are all correct and the pedalling is still wrong.',
    data: 'The interleaving of controller 64 events and note events around each pedal change.',
  },
];

export function verdictInfo(key: string): VerdictInfo | undefined {
  return VERDICT_INFO.find(v => v.key === key);
}

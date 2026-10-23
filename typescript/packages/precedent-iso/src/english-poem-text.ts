const UNSAFE_CONTROL =
  // eslint-disable-next-line no-control-regex -- Reject unsafe text at the public label boundary.
  /[\u{0000}-\u{0008}\u{000b}\u{000c}\u{000e}-\u{001f}\u{007f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u;
const GENERATION_FAILURE_PATTERN =
  /(?:roses are red|unable to translate|cannot translate|can't translate|i(?:'| a)m sorry.{0,80}translat|as an ai|translation guidelines|translate the following|provide (?:a )?summary instead)/iu;
const GENERATED_TITLE_FAILURE_PATTERN =
  /(?:i (?:do not|don't).{0,80}translat|i (?:have )?translated|i have (?:chosen|given|made).{0,80}translat|i(?:'m| am) an ai|assistant created by|here(?:'s| is).{0,100}(?:attempt|english|translat)|english translation|arabic poem title|title translated|from english to arabic|you are an arabic|attempt at translat|^i (?:will not|have nothing|have not|presume not|did not|am not able).{0,180}(?:translat|output|provide|copyright|permission|context)|^you(?:'re| are) right.{0,180}translat|^translated to\b|^titles? translated(?: to english)?$|^my poem translation:?$|without proper context|copyrighted material|let's have (?:a |an )?(?:engaging|respectful|thoughtful) (?:conversation|discussion)|please provide (?:an |the )?(?:arabic|english|translation)|as requested.{0,120}(?:output|translat)|do not speak arabic|don't speak arabic|not attempt to translat|refrain from translat|kept the translated poem private|translation capabilities|translation services|rough translation of the title|entrust you.{0,80}translate|nice try.{0,80}translate|without permission.{0,80}(?:translate|copyright)|my friend.{0,120}(?:cannot provide|thoughtful discussion))/iu;
function isUsableGeneratedText(value: string, maximumLength: number): boolean {
  const text = value.trim();
  return (
    text.length > 0 &&
    text.length <= maximumLength &&
    !/[\r\n]/u.test(text) &&
    !UNSAFE_CONTROL.test(text) &&
    !GENERATION_FAILURE_PATTERN.test(text) &&
    !GENERATED_TITLE_FAILURE_PATTERN.test(text)
  );
}

export function isUsablePoemTitle(value: string): boolean {
  return isUsableGeneratedText(value, 200);
}

export function firstEnglishPoemLine(
  tracks: readonly { lines: readonly string[] }[],
  nonblankArabicLineIndexes: readonly number[]
): string | undefined {
  for (const track of tracks) {
    for (const index of nonblankArabicLineIndexes) {
      const line = track.lines[index]?.trim();
      if (
        line &&
        /\p{Script=Latin}/u.test(line) &&
        isUsableGeneratedText(line, 5_000)
      ) {
        return line;
      }
    }
  }
  return undefined;
}

// Lightweight text normalization helpers for intent detection.
// Keep logic simple and fast; avoid heavy NLP.

export function expandTimeShorthand(text: string): string {
  let s = text;
  // Day shorthands
  s = s.replace(/\btmrw\b/gi, 'tomorrow');
  s = s.replace(/\btmr\b/gi, 'tomorrow');
  s = s.replace(/\btoday\b/gi, 'today');
  s = s.replace(/\btonite\b/gi, 'tonight');
  s = s.replace(/\btonite\b/gi, 'tonight');
  s = s.replace(/\btonite\b/gi, 'tonight');
  s = s.replace(/\btonight\b/gi, 'tonight');

  // Weekday shorthands
  s = s.replace(/\bmon\b/gi, 'monday');
  s = s.replace(/\btue\b|\btues\b/gi, 'tuesday');
  s = s.replace(/\bwed\b/gi, 'wednesday');
  s = s.replace(/\bthu\b|\bthur\b|\bthurs\b/gi, 'thursday');
  s = s.replace(/\bfri\b/gi, 'friday');
  s = s.replace(/\bsat\b/gi, 'saturday');
  s = s.replace(/\bsun\b/gi, 'sunday');

  // Common time expressions
  s = s.replace(/\bnoon\b/gi, '12:00 pm');
  s = s.replace(/\bmidnight\b/gi, '12:00 am');
  s = s.replace(/\bafternoon\b/gi, '2 pm');
  s = s.replace(/\bevening\b/gi, '6 pm');
  s = s.replace(/\bmorning\b/gi, '9 am');

  // Normalize am/pm spacing like '2 pm' vs '2pm'
  s = s.replace(/\b(\d{1,2})\s?(am|pm)\b/gi, '$1 $2');

  return s;
}

export function normalizeForIntent(text: string): string {
  let s = text.toLowerCase();
  // Soft profanity / vague items -> neutral tokens (for downstream intent maps)
  s = s.replace(/\b(shit|crap|stuff|things|junk)\b/gi, ' items ');
  // Affirmations / denials (not used directly yet, reserved for future rules)
  s = s.replace(/\b(yeah|yup|yep|ya|bet|fr)\b/gi, ' yes ');
  s = s.replace(/\b(nah|nope)\b/gi, ' no ');
  // Scheduling intent boosters
  s = s.replace(/\basap\b/gi, ' asap ');
  s = s.replace(/\bsoonest\b/gi, ' soonest ');
  s = s.replace(/\bnext\b/gi, ' next ');
  // Common misspellings
  s = s.replace(/\btomm?or+ow\b/gi, ' tomorrow ');
  return s.trim().replace(/\s+/g, ' ');
}


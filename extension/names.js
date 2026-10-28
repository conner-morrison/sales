/**
 * First names the prefilter would exclude. Empty, and no longer consulted by
 * shouldEnrich: a first-name list screens people by ethnicity, not by their job.
 *
 * One per line. A person is excluded when their FIRST name matches an entry -- the
 * first word of the name on the card, not any word in it. "Ali" therefore excludes Ali
 * Hassan but not Mohammed Ali, who is a different person from the ones the entry is
 * about and who would get no second look.
 *
 * Matching is case-insensitive and ignores accents and punctuation, so "Jose" matches
 * "José" and "D'Angelo" matches "DAngelo".
 *
 * It matches whole names, never fragments: "Ali" does not match Alison, Natalia or
 * Kowalski, which is what a substring match would have done quietly.
 *
 * The list can be long without costing anything -- entries go into a set and are
 * checked in constant time, however many there are.
 */

export const NAMES = [];


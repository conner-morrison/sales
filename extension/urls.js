/**
 * Profile URLs.
 *
 * When the public profile URL could not be found, all a lead has is its Sales
 * Navigator link:
 *
 *     https://www.linkedin.com/sales/lead/ACwAAAai...,NAME_SEARCH,uvew?_ntb=...
 *
 * The id before the first comma is the member's id, and linkedin.com/in/ accepts it
 * in place of the vanity name, so this turns into a link to the ordinary profile:
 *
 *     https://www.linkedin.com/in/ACwAAAai...
 */
export function profileUrl(url) {
  const m = String(url || "").match(/\/sales\/lead\/([^,?#/]+)/);
  return m ? `https://www.linkedin.com/in/${m[1]}` : url;
}

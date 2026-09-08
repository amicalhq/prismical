/** Official HTTPS links can open directly; all other destinations keep the confirmation. */
export function isOfficialProductLink(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === 'prismical.ai' || url.hostname.endsWith('.prismical.ai'))
    );
  } catch {
    // Malformed and relative links are not eligible for the official-domain exemption.
    return false;
  }
}

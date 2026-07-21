/**
 * Browser cookie mutations must carry a non-simple header in addition to a
 * trusted Origin. Cross-site forms cannot set it, and untrusted fetches cannot
 * pass the server's CORS preflight.
 */
export const SYNARA_CSRF_HEADER_NAME = "X-Synara-CSRF";
export const SYNARA_CSRF_HEADER_VALUE = "1";
